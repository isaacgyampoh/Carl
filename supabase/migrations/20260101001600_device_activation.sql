-- =============================================================================
-- 0016 · Device activation and authorisation
--
-- ## The installation flow
--
--   1. Carl staff create a device row               -> status PENDING
--   2. Carl staff issue an activation code          -> hash stored, code shown once
--   3. Installer types the code into a fresh till
--   4. The till calls activate_device()             -> status ACTIVE, secret issued
--   5. The till stores the secret and syncs
--
-- ## Why codes and secrets are hashed
--
-- Both are bearer credentials: whoever holds one can act as that terminal. Stored in
-- plaintext, a database dump - or a support engineer with a live support grant - would
-- yield a working key to every till. Only SHA-256 hashes are stored, peppered with a
-- server-side secret that never enters the database, so a dump alone is not enough to
-- brute-force short codes.
--
-- ## Why activation is idempotent
--
-- Installations happen on unreliable connections, in shops, under time pressure. If the
-- response to activate_device() is lost, the installer retries. Without protection the
-- second attempt reports "code already consumed" and the installer is stuck with a till
-- that is activated but has no secret. Retrying with the same install_id returns the same
-- session instead.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Hashing
--
-- The pepper is passed in by the caller (from CARL_DEVICE_SECRET_PEPPER, server-side
-- only) rather than stored in the database. A database compromise therefore does not
-- yield the pepper, and short activation codes stay resistant to offline brute force.
-- -----------------------------------------------------------------------------

create or replace function app.hash_credential(p_value text, p_pepper text)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select extensions.digest(p_pepper || ':' || p_value, 'sha256')
$$;

comment on function app.hash_credential(text, text) is
  'SHA-256 of a peppered credential. The pepper lives in the application environment, never here.';

-- -----------------------------------------------------------------------------
-- issue_activation_code
--
-- Returns the plaintext code exactly once. It is never stored and cannot be recovered.
-- -----------------------------------------------------------------------------

create or replace function issue_activation_code(
  p_device_id    uuid,
  p_pepper       text,
  p_valid_hours  integer default 24
)
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device   record;
  v_code     text;
  v_expires  timestamptz;
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- no I, O, 0, 1
  i          integer;
begin
  select d.id, d.tenant_id, d.branch_id, d.status
    into v_device
  from public.devices d
  where d.id = p_device_id;

  if not found then
    raise exception 'DEVICE_NOT_FOUND';
  end if;

  if not (
    app.has_permission(v_device.tenant_id, 'devices.manage', v_device.branch_id)
    or app.is_platform_admin()
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if v_device.status = 'REVOKED' then
    raise exception 'DEVICE_REVOKED';
  end if;

  if p_valid_hours < 1 or p_valid_hours > 48 then
    raise exception 'VALIDATION_FAILED'
      using detail = 'An activation window must be between 1 and 48 hours.';
  end if;

  -- 12 characters from a 32-symbol alphabet is 60 bits of entropy - far beyond guessing
  -- within a 24-hour window, while still being typable by an installer. The alphabet
  -- excludes I, O, 0 and 1, which are misread constantly when transcribed by hand.
  v_code := '';
  for i in 1..12 loop
    -- gen_random_bytes is a CSPRNG. random() is not, and a predictable activation code is
    -- a predictable way into a tenant.
    v_code := v_code || substr(
      v_alphabet,
      1 + (get_byte(extensions.gen_random_bytes(1), 0) % length(v_alphabet)),
      1
    );
  end loop;

  v_expires := now() + make_interval(hours => p_valid_hours);

  -- Issuing a new code invalidates any outstanding one. Otherwise a code left in an old
  -- email stays usable, and the partial unique index would reject this insert anyway.
  update public.device_activations
     set revoked_at = now()
   where device_id = p_device_id
     and consumed_at is null
     and revoked_at is null;

  insert into public.device_activations
    (tenant_id, device_id, code_hash, code_hint, expires_at, created_by)
  values (
    v_device.tenant_id,
    p_device_id,
    app.hash_credential(v_code, p_pepper),
    right(v_code, 4),
    v_expires,
    auth.uid()
  );

  insert into public.audit_logs (tenant_id, branch_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_device.tenant_id, v_device.branch_id, auth.uid(),
    'DEVICE_ACTIVATION_CODE_ISSUED', 'device', p_device_id,
    jsonb_build_object('code_hint', right(v_code, 4), 'expires_at', v_expires)
  );

  return query select v_code, v_expires;
end;
$$;

comment on function issue_activation_code(uuid, text, integer) is
  'Issues a single-use activation code. Returns the plaintext once; only a peppered hash is stored.';

revoke execute on function issue_activation_code(uuid, text, integer) from public, anon;
grant execute on function issue_activation_code(uuid, text, integer) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- activate_device
--
-- Consumes a code and issues a device secret. Runs as the service role from a server
-- action: the terminal is not yet trusted and has no session of its own.
-- -----------------------------------------------------------------------------

create or replace function activate_device(
  p_code       text,
  p_pepper     text,
  p_install_id text,
  p_platform   device_platform default null,
  p_app_version text default null
)
returns table (
  device_id        uuid,
  tenant_id        uuid,
  branch_id        uuid,
  device_code      text,
  device_name      text,
  device_secret    text,
  authorized_until timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activation record;
  v_device     record;
  v_tenant     record;
  v_secret     text;
  v_authorized timestamptz;
  v_existing   record;
begin
  if p_install_id is null or length(btrim(p_install_id)) = 0 then
    raise exception 'VALIDATION_FAILED' using detail = 'An installation identifier is required.';
  end if;

  -- Looked up by hash, so the plaintext code is never compared in the database and a
  -- wrong code is indistinguishable from a non-existent one.
  select a.* into v_activation
  from public.device_activations a
  where a.code_hash = app.hash_credential(p_code, p_pepper);

  if not found then
    raise exception 'ACTIVATION_CODE_INVALID';
  end if;

  if v_activation.revoked_at is not null then
    raise exception 'ACTIVATION_CODE_INVALID';
  end if;

  if v_activation.expires_at <= now() then
    raise exception 'ACTIVATION_CODE_EXPIRED';
  end if;

  select d.* into v_device from public.devices d where d.id = v_activation.device_id;

  if v_device.status = 'REVOKED' then
    raise exception 'DEVICE_REVOKED';
  end if;

  select t.* into v_tenant from public.tenants t where t.id = v_device.tenant_id;

  if v_tenant.status in ('SUSPENDED', 'CANCELLED') then
    raise exception 'TENANT_SUSPENDED';
  end if;

  -- Idempotent retry: the same installation re-presenting the same code gets its existing
  -- session back rather than an error. Losing the response to this call on a shop's flaky
  -- connection is expected, not exceptional.
  if v_activation.consumed_at is not null then
    select s.* into v_existing
    from public.device_sessions s
    where s.device_id = v_device.id
      and s.install_id = p_install_id
      and s.revoked_at is null;

    if found then
      -- The secret is not recoverable from its hash, so a genuine retry must be issued a
      -- fresh one. The previous session row is replaced rather than left dangling.
      v_secret := encode(extensions.gen_random_bytes(32), 'hex');
      update public.device_sessions
         set secret_hash = app.hash_credential(v_secret, p_pepper),
             last_seen_at = now()
       where id = v_existing.id;

      update public.devices
         set secret_hash = app.hash_credential(v_secret, p_pepper),
             secret_rotated_at = now()
       where id = v_device.id;

      -- devices.code and devices.name are domains (app.slug / app.label). PostgreSQL
      -- requires an exact type match on a RETURNS TABLE column, so they are cast rather
      -- than returned as their domain type: callers want plain text.
      return query
        select v_device.id, v_device.tenant_id, v_device.branch_id,
               v_device.code::text, v_device.name::text, v_secret, v_device.authorized_until;
      return;
    end if;

    raise exception 'ACTIVATION_CODE_CONSUMED';
  end if;

  if v_activation.attempt_count >= v_activation.max_attempts then
    raise exception 'ACTIVATION_CODE_INVALID';
  end if;

  -- 256 bits from a CSPRNG. This is the terminal's long-lived credential.
  v_secret := encode(extensions.gen_random_bytes(32), 'hex');
  v_authorized := now() + make_interval(hours => v_device.offline_grace_hours);

  update public.device_activations
     set consumed_at = now(),
         attempt_count = attempt_count + 1
   where id = v_activation.id;

  update public.devices
     set status = 'ACTIVE',
         secret_hash = app.hash_credential(v_secret, p_pepper),
         secret_rotated_at = now(),
         platform = coalesce(p_platform, platform),
         app_version = coalesce(p_app_version, app_version),
         activated_at = coalesce(activated_at, now()),
         authorized_until = v_authorized,
         last_seen_at = now()
   where id = v_device.id;

  insert into public.device_sessions (device_id, tenant_id, secret_hash, install_id, expires_at)
  values (
    v_device.id, v_device.tenant_id,
    app.hash_credential(v_secret, p_pepper),
    p_install_id,
    now() + interval '365 days'
  );

  insert into public.audit_logs (tenant_id, branch_id, action, entity_type, entity_id, device_id, metadata)
  values (
    v_device.tenant_id, v_device.branch_id, 'DEVICE_ACTIVATED', 'device', v_device.id, v_device.id,
    jsonb_build_object('install_id', p_install_id, 'platform', p_platform)
  );

  return query
    select v_device.id, v_device.tenant_id, v_device.branch_id,
           v_device.code::text, v_device.name::text, v_secret, v_authorized;
end;
$$;

comment on function activate_device is
  'Consumes an activation code and issues a device secret. Idempotent per install_id, because installs happen on unreliable connections.';

revoke execute on function activate_device from public, anon, authenticated;
grant execute on function activate_device to service_role;

-- -----------------------------------------------------------------------------
-- authorize_device
--
-- Called on every privileged terminal operation. Answers one question: may this terminal
-- act right now?
-- -----------------------------------------------------------------------------

create or replace function app.authorize_device(
  p_device_id uuid,
  p_secret    text,
  p_pepper    text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_device record;
  v_tenant record;
begin
  select d.* into v_device from public.devices d where d.id = p_device_id;
  if not found then
    raise exception 'DEVICE_NOT_FOUND';
  end if;

  if v_device.status = 'REVOKED' then
    raise exception 'DEVICE_REVOKED';
  end if;

  if v_device.status <> 'ACTIVE' then
    raise exception 'DEVICE_NOT_ACTIVATED';
  end if;

  -- Compared as hashes. A timing difference here would leak the secret one byte at a
  -- time; bytea equality on two 32-byte digests does not vary usefully with the input.
  if v_device.secret_hash is distinct from app.hash_credential(p_secret, p_pepper) then
    raise exception 'DEVICE_NOT_ACTIVATED'
      using detail = 'The device credential did not match.';
  end if;

  -- The offline authorisation window. A terminal that has not reached the server within
  -- its grace period stops, which is what bounds the usefulness of a stolen till.
  if v_device.authorized_until is not null and v_device.authorized_until <= now() then
    raise exception 'DEVICE_AUTHORIZATION_EXPIRED';
  end if;

  select t.* into v_tenant from public.tenants t where t.id = v_device.tenant_id;
  if v_tenant.status in ('SUSPENDED', 'CANCELLED') then
    raise exception 'TENANT_SUSPENDED';
  end if;

  return true;
end;
$$;

comment on function app.authorize_device(uuid, text, text) is
  'Whether a terminal may act now: activated, credential matches, within its offline window, tenant in good standing.';

-- -----------------------------------------------------------------------------
-- revoke_device
-- -----------------------------------------------------------------------------

create or replace function revoke_device(p_device_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
begin
  select d.* into v_device from public.devices d where d.id = p_device_id;
  if not found then
    raise exception 'DEVICE_NOT_FOUND';
  end if;

  if not (
    app.has_permission(v_device.tenant_id, 'devices.manage', v_device.branch_id)
    or app.is_platform_admin()
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'VALIDATION_FAILED' using detail = 'A revocation reason is required.';
  end if;

  update public.devices
     set status = 'REVOKED',
         revoked_at = now(),
         revoked_by = auth.uid(),
         revoked_reason = p_reason,
         -- Clearing this stops the terminal at its next authorisation check rather than
         -- letting it trade to the end of its offline window.
         authorized_until = now(),
         secret_hash = null
   where id = p_device_id;

  update public.device_sessions
     set revoked_at = now()
   where device_id = p_device_id and revoked_at is null;

  update public.device_activations
     set revoked_at = now()
   where device_id = p_device_id and consumed_at is null and revoked_at is null;

  insert into public.audit_logs (tenant_id, branch_id, actor_id, action, entity_type, entity_id, device_id, metadata)
  values (
    v_device.tenant_id, v_device.branch_id, auth.uid(),
    'DEVICE_REVOKED', 'device', p_device_id, p_device_id,
    jsonb_build_object('reason', p_reason)
  );
end;
$$;

comment on function revoke_device(uuid, text) is
  'Permanently stops a terminal. Clears its credential and offline window so it halts at the next check.';

revoke execute on function revoke_device(uuid, text) from public, anon;
grant execute on function revoke_device(uuid, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- devices_safe
--
-- The view application code reads. Omits secret_hash entirely, so a careless `select *`
-- cannot put a credential hash into a log, an API response or a React prop.
-- -----------------------------------------------------------------------------

create view devices_safe
with (security_invoker = true)
as
select
  d.id, d.tenant_id, d.branch_id, d.code, d.name, d.status, d.platform,
  d.app_version, d.os_version, d.last_seen_at, d.last_sync_at,
  d.pending_sync_count, d.authorized_until, d.offline_grace_hours,
  d.activated_at, d.revoked_at, d.revoked_reason, d.created_at, d.updated_at,
  -- Derived operational state, so the "terminals needing attention" view does not
  -- reimplement this rule in three places.
  case
    when d.status = 'REVOKED' then 'REVOKED'
    when d.status <> 'ACTIVE' then 'INACTIVE'
    when d.authorized_until is not null and d.authorized_until <= now() then 'EXPIRED'
    when d.last_seen_at is null or d.last_seen_at < now() - interval '1 hour' then 'OFFLINE'
    else 'ONLINE'
  end as health
from public.devices d;

comment on view devices_safe is
  'Devices without secret_hash. Application code reads this so a careless select * cannot leak a credential hash.';

grant select on devices_safe to authenticated;
