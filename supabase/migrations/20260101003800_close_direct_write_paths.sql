-- =============================================================================
-- 0038 · Close the direct-write paths around the guarded functions
--
-- ## What was open
--
-- Supabase grants `authenticated` every privilege on every public table and relies on RLS
-- to decide. For most tables that is right. For the tables that decide who a person is and
-- what they may do, the write policies were broader than the rules the application enforces
-- — so anyone could skip the guarded functions and call the REST API directly:
--
--   * tenant_memberships INSERT (staff.manage): attach ANY existing account, with a PIN hash
--     computed in the browser. The cross-tenant takeover `add_staff_member` refuses.
--   * tenant_memberships UPDATE (staff.manage): rewrite a stronger member's `pin_hash` or
--     `user_id`. A branch manager could take over an administrator — the escalation
--     `set_member_pin` was fixed to refuse in 0037, reachable by not calling it.
--   * membership_roles DELETE (roles.manage, no rank check): strip the owner's role.
--   * membership_branches (staff.manage): restrict or strip a stronger member's branches.
--   * roles UPDATE (roles.manage, no rank or system check): re-rank a role above the owner,
--     which defeats every rank guard in the schema at once.
--   * role_permissions (roles.manage): remove permissions from the owner's system role.
--   * tenants UPDATE (owner or settings.manage): any column. A business on trial could set
--     `trial_ends_at` years ahead, or rewrite its own `status`, `slug` or `currency_code` —
--     undoing the platform owner's billing control.
--   * profiles UPDATE (self): any column, including `email`, which PIN sign-in used to mint
--     the session. A unique index stopped anyone claiming an address another profile already
--     held, but identity must not rest on a column its holder can edit.
--
-- No application code writes any of these tables directly; every legitimate change already
-- goes through a SECURITY DEFINER function, which runs as the owner and is unaffected by
-- these revocations.
--
-- ## What remains allowed
--
-- A business owner can still edit their business's own details, and a person can still edit
-- their own name, phone and avatar — as column-level grants, so nothing else rides along.
-- =============================================================================

-- Staff, roles and permissions: only through the guarded functions.
revoke insert, update, delete on public.tenant_memberships from authenticated;
revoke insert, update, delete on public.membership_roles from authenticated;
revoke insert, update, delete on public.membership_branches from authenticated;
revoke insert, update, delete on public.roles from authenticated;
revoke insert, update, delete on public.role_permissions from authenticated;

-- A business edits its own details. Slug, status, currency, country, trial, suspension and
-- cancellation belong to the platform owner and are changed only by platform functions.
revoke update on public.tenants from authenticated;
grant update (
  name, legal_name, contact_person, email, phone, address, timezone,
  logo_url, receipt_footer, tax_registration_no, default_tax_rate, prices_include_tax
) on public.tenants to authenticated;

-- A person edits their own name and contact details, never the email sign-in resolves to.
revoke update on public.profiles from authenticated;
grant update (full_name, phone, avatar_url) on public.profiles to authenticated;

-- -----------------------------------------------------------------------------
-- verify_member_pin — the session's email comes from auth.users, not profiles
--
-- Unchanged apart from the join: the throttle, the status refusals and the timing of every
-- answer are exactly as before.
-- -----------------------------------------------------------------------------
create or replace function verify_member_pin(p_tenant_slug text, p_pin text)
returns table (
  out_status      text,
  out_user_id     uuid,
  out_email       text,
  out_tenant_id   uuid,
  out_must_change boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tenant   record;
  v_throttle record;
  v_member   record;
  v_delay    interval;
  v_failures integer;
begin
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    return query select 'INVALID'::text, null::uuid, null::text, null::uuid, null::boolean;
    return;
  end if;

  select t.id, t.status into v_tenant
  from public.tenants t
  where t.slug = lower(btrim(coalesce(p_tenant_slug, '')));

  if not found then
    -- Same answer as a wrong PIN, so the response cannot be used to discover which
    -- businesses exist on Carl.
    return query select 'INVALID'::text, null::uuid, null::text, null::uuid, null::boolean;
    return;
  end if;

  if v_tenant.status in ('SUSPENDED', 'CANCELLED') then
    return query select 'SUSPENDED'::text, null::uuid, null::text, v_tenant.id, null::boolean;
    return;
  end if;

  -- Created on demand: without this a missing row leaves the UPDATE below matching nothing,
  -- silently removing brute-force protection while every call still appears to work.
  insert into public.tenant_pin_throttle (tenant_id) values (v_tenant.id)
    on conflict (tenant_id) do nothing;
  select * into v_throttle
  from public.tenant_pin_throttle
  where tenant_pin_throttle.tenant_id = v_tenant.id
  for update;

  if v_throttle.locked_until is not null and v_throttle.locked_until > now() then
    return query select 'LOCKED'::text, null::uuid, null::text, v_tenant.id, null::boolean;
    return;
  end if;

  for v_member in
    -- auth.users, not profiles: the session is minted for this address, and it must be
    -- the account's own, not a column its holder could once edit.
    select tm.user_id as uid, u.email::text as mail, tm.pin_hash as hash,
           tm.pin_must_change as mustchg, tm.id as membership_id
    from public.tenant_memberships tm
    join auth.users u on u.id = tm.user_id
    where tm.tenant_id = v_tenant.id
      and tm.status = 'ACTIVE'
      and tm.pin_hash is not null
  loop
    if v_member.hash = extensions.crypt(p_pin, v_member.hash) then
      update public.tenant_pin_throttle
         set consecutive_failures = 0, locked_until = null, last_attempt_at = now()
       where tenant_pin_throttle.tenant_id = v_tenant.id;
      update public.tenant_memberships tm
         set last_login_at = now()
       where tm.id = v_member.membership_id;

      return query
        select 'OK'::text, v_member.uid, v_member.mail, v_tenant.id, v_member.mustchg;
      return;
    end if;
  end loop;

  v_failures := coalesce(v_throttle.consecutive_failures, 0) + 1;
  v_delay := case
    when v_failures < 5  then null
    when v_failures < 8  then interval '30 seconds'
    when v_failures < 12 then interval '2 minutes'
    else interval '10 minutes'
  end;

  update public.tenant_pin_throttle
     set consecutive_failures = v_failures,
         last_attempt_at = now(),
         locked_until = case when v_delay is null then null else now() + v_delay end
   where tenant_pin_throttle.tenant_id = v_tenant.id;

  return query select 'INVALID'::text, null::uuid, null::text, v_tenant.id, null::boolean;
end;
$$;

-- -----------------------------------------------------------------------------
-- verify_platform_pin — the same change, for the platform owner
-- -----------------------------------------------------------------------------
create or replace function verify_platform_pin(p_pin text)
returns table (status text, user_id uuid, email text, is_default boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_throttle record;
  v_admin    record;
  v_delay    interval;
  v_failures integer;
begin
  /*
   * This function RETURNS a status and never raises on a bad PIN. That is load-bearing.
   *
   * `raise exception` aborts the transaction, which would roll back the very UPDATE that
   * records the failed attempt. Written that way the counter could never increment: the
   * throttle looked present, every call behaved plausibly, and each wrong guess was free.
   * Returning a status lets the increment commit, which is the only reason the lockout
   * works at all.
   */
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    return query select 'INVALID'::text, null::uuid, null::text, null::boolean;
    return;
  end if;

  -- Created if missing, then locked. Without the insert a restore or stray DELETE would
  -- leave the UPDATE below matching nothing, silently removing brute-force protection.
  insert into public.platform_pin_throttle (id) values (true) on conflict (id) do nothing;
  select * into v_throttle from public.platform_pin_throttle where id limit 1 for update;

  if v_throttle.locked_until is not null and v_throttle.locked_until > now() then
    -- The remaining time is not disclosed: it tells an attacker how the backoff is shaped
    -- and exactly how long to sleep between batches.
    return query select 'LOCKED'::text, null::uuid, null::text, null::boolean;
    return;
  end if;

  -- Checked against every administrator holding a PIN. There is realistically one, and
  -- iterating keeps a second owner from being locked out of their own console.
  for v_admin in
    select pa.user_id as uid, u.email::text as mail, pa.pin_hash as hash, pa.pin_is_default as dflt
    from public.platform_admins pa
    join auth.users u on u.id = pa.user_id
    where pa.pin_hash is not null
  loop
    if v_admin.hash = extensions.crypt(p_pin, v_admin.hash) then
      update public.platform_pin_throttle
         set consecutive_failures = 0, locked_until = null, last_attempt_at = now()
       where id;
      update public.platform_admins pa
         set last_login_at = now()
       where pa.user_id = v_admin.uid;

      return query select 'OK'::text, v_admin.uid, v_admin.mail, v_admin.dflt;
      return;
    end if;
  end loop;

  /*
   * Wrong. Backoff grows with consecutive failures: nothing for the first three, then
   * seconds, then minutes, then a quarter of an hour. Ten thousand possibilities at
   * fifteen minutes a throw is not an attack anybody finishes.
   */
  v_failures := coalesce(v_throttle.consecutive_failures, 0) + 1;
  v_delay := case
    when v_failures < 3  then null
    when v_failures < 5  then interval '30 seconds'
    when v_failures < 8  then interval '2 minutes'
    when v_failures < 12 then interval '5 minutes'
    else interval '15 minutes'
  end;

  update public.platform_pin_throttle
     set consecutive_failures = v_failures,
         last_attempt_at = now(),
         locked_until = case when v_delay is null then null else now() + v_delay end
   where id;

  -- The same answer whether or not a PIN is configured, so the response cannot be used to
  -- discover whether the console has been set up.
  return query select 'INVALID'::text, null::uuid, null::text, null::boolean;
end;
$$;
