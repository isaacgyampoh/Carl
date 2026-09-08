-- =============================================================================
-- 0003 · POS terminals
--
-- ## Why a device is a first-class identity
--
-- A cashier's login says who is selling. It does not say which physical till the money
-- went into, which drawer to reconcile, or which terminal has stopped syncing. It also
-- does not help when a laptop running Carl is stolen: revoking the employee's account
-- leaves the machine's cached credentials working.
--
-- Devices are therefore authenticated separately from users. A sale carries both.
--
-- ## How a device authenticates
--
-- The desktop application holds a device secret issued at activation. Carl stores only a
-- SHA-256 hash of it, so a dump of the devices table yields nothing usable - the same
-- reasoning as password storage.
--
-- The secret is presented alongside the user's session on every privileged call. It is
-- not a substitute for user authentication; it is a second, independent factor
-- identifying the terminal.
--
-- ## Offline authorisation
--
-- A terminal cannot phone home to check whether it is still allowed to operate; that is
-- the entire point of offline mode. Instead each device carries `authorized_until`,
-- refreshed on every successful sync. A terminal that cannot reach the server keeps
-- working until that moment passes, then stops.
--
-- The window is a deliberate trade-off. Too short and a genuine outage closes the shop.
-- Too long and a stolen terminal keeps trading for weeks. The default is seven days,
-- and it is a per-device column so a high-risk site can be tightened without redeploying.
-- =============================================================================

create type device_status as enum (
  'PENDING',    -- created; activation code issued, not yet claimed
  'ACTIVE',
  'SUSPENDED',  -- temporarily stopped; may be reinstated
  'REVOKED'     -- permanently stopped; lost, stolen or decommissioned
);

create type device_platform as enum ('WINDOWS', 'MACOS', 'LINUX', 'WEB', 'ANDROID', 'IOS');

-- -----------------------------------------------------------------------------
-- devices
-- -----------------------------------------------------------------------------

create table devices (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  branch_id         uuid not null references branches (id) on delete restrict,

  code              app.slug not null,
  name              app.label not null,
  status            device_status not null default 'PENDING',
  platform          device_platform,

  -- SHA-256 of the device secret, peppered with a server-side value. Never the secret.
  secret_hash       bytea,
  secret_rotated_at timestamptz,

  app_version       text,
  os_version        text,

  -- Operational telemetry, updated by the sync engine. Drives the "which terminal has
  -- gone quiet" view rather than requiring a support call to discover it.
  last_seen_at      timestamptz,
  last_sync_at      timestamptz,
  pending_sync_count integer not null default 0,

  -- Offline authorisation. See the header note.
  authorized_until  timestamptz,
  offline_grace_hours integer not null default 168,   -- 7 days

  activated_at      timestamptz,
  activated_by      uuid references profiles (id) on delete set null,
  suspended_at      timestamptz,
  revoked_at        timestamptz,
  revoked_by        uuid references profiles (id) on delete set null,
  revoked_reason    text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint devices_pending_sync_non_negative check (pending_sync_count >= 0),
  constraint devices_grace_within_bounds check (offline_grace_hours between 1 and 720),

  -- An active device must actually have been activated and hold a secret. Without this,
  -- a row flipped to ACTIVE by a bad script would be trusted while having no credential.
  constraint devices_active_is_activated check (
    status <> 'ACTIVE' or (activated_at is not null and secret_hash is not null)
  ),
  constraint devices_revocation_documented check (
    status <> 'REVOKED' or (revoked_at is not null and revoked_reason is not null)
  )
);

create unique index devices_tenant_code_key on devices (tenant_id, code);
create index devices_branch_idx on devices (branch_id, status);
create index devices_tenant_status_idx on devices (tenant_id, status);
-- Supports the platform-admin "terminals needing attention" view.
create index devices_stale_idx on devices (last_sync_at) where status = 'ACTIVE';

comment on column devices.secret_hash is
  'SHA-256 of the peppered device secret. The secret itself is shown once, at activation, and never stored.';
comment on column devices.authorized_until is
  'How long this terminal may operate without reaching the server. Refreshed on each sync.';

create trigger devices_touch_updated_at
  before update on devices
  for each row execute function app.touch_updated_at();

-- A device must live in a branch belonging to its own tenant. Two independent foreign
-- keys do not express this, and a mismatch would place a terminal inside another
-- business's branch.
create or replace function app.assert_device_branch_same_tenant()
returns trigger
language plpgsql
as $$
declare
  v_branch_tenant uuid;
begin
  select tenant_id into v_branch_tenant from branches where id = new.branch_id;
  if v_branch_tenant is distinct from new.tenant_id then
    raise exception 'CROSS_TENANT_REFERENCE'
      using detail = 'The device branch belongs to a different tenant.';
  end if;
  return new;
end;
$$;

create trigger devices_branch_same_tenant
  before insert or update on devices
  for each row execute function app.assert_device_branch_same_tenant();

-- -----------------------------------------------------------------------------
-- device_activations
--
-- ## Activation codes
--
-- A short code an installer types into a fresh terminal. It is a bearer credential during
-- its brief life, so it is treated like one:
--
--   * generated from a CSPRNG, never a sequence or a timestamp
--   * stored only as a hash - a leaked database gives no working codes
--   * short-lived (hours, not days)
--   * single-use, enforced by a unique index rather than by application logic
--   * revocable, and every attempt recorded
--
-- Attempts are counted so a code being guessed is visible rather than silent.
-- -----------------------------------------------------------------------------

create table device_activations (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,
  device_id      uuid not null references devices (id) on delete cascade,

  -- SHA-256 of the peppered code. The plaintext exists only in the installer's hands.
  code_hash      bytea not null,
  -- The last four characters, so support can identify which code is being discussed
  -- without ever handling a working one.
  code_hint      text not null,

  expires_at     timestamptz not null,
  max_attempts   smallint not null default 5,
  attempt_count  smallint not null default 0,

  consumed_at    timestamptz,
  consumed_by    uuid references profiles (id) on delete set null,
  consumed_ip    inet,

  revoked_at     timestamptz,
  revoked_by     uuid references profiles (id) on delete set null,

  created_by     uuid references profiles (id) on delete set null,
  created_at     timestamptz not null default now(),

  constraint device_activations_hint_format check (code_hint ~ '^[A-Z0-9]{4}$'),
  constraint device_activations_attempts_within_limit check (attempt_count >= 0 and attempt_count <= max_attempts),
  constraint device_activations_expires_after_creation check (expires_at > created_at),
  -- A window measured in days is not a short-lived credential.
  constraint device_activations_window_bounded check (expires_at <= created_at + interval '48 hours')
);

create unique index device_activations_code_hash_key on device_activations (code_hash);

-- At most one live code per device: issuing a second must invalidate the first, or an
-- old code left in an email remains usable.
create unique index device_activations_one_live_per_device
  on device_activations (device_id)
  where consumed_at is null and revoked_at is null;

create index device_activations_tenant_idx on device_activations (tenant_id, created_at desc);

comment on table device_activations is
  'Single-use, short-lived codes that bind a terminal to a tenant and branch. Stored hashed.';

-- -----------------------------------------------------------------------------
-- device_sessions
--
-- Each activated installation gets a session row. Rotating a secret or revoking one
-- installation does not disturb the others, and the "sign out this terminal" action has
-- something concrete to act on.
-- -----------------------------------------------------------------------------

create table device_sessions (
  id             uuid primary key default gen_random_uuid(),
  device_id      uuid not null references devices (id) on delete cascade,
  tenant_id      uuid not null references tenants (id) on delete cascade,

  secret_hash    bytea not null,
  install_id     text not null,

  last_seen_at   timestamptz not null default now(),
  expires_at     timestamptz not null,
  revoked_at     timestamptz,

  created_at     timestamptz not null default now()
);

create unique index device_sessions_secret_hash_key on device_sessions (secret_hash);
create unique index device_sessions_device_install_key on device_sessions (device_id, install_id);
create index device_sessions_device_idx on device_sessions (device_id) where revoked_at is null;

comment on table device_sessions is
  'One row per installation of Carl Desktop. Lets a single terminal be signed out without disturbing others.';
