-- =============================================================================
-- 0032 · Staff PINs
--
-- A shop's people sign in with four digits and nothing else. No email, no password, no
-- verification link.
--
-- ## The PIN identifies a PERSON, not a business
--
-- This is the whole design. `complete_sale` requires a user holding `sales.create` at that
-- branch, and every sale carries `cashier_id`. One PIN per shop would attribute every
-- transaction to the same identity, and "which cashier voided that sale?" — usually the
-- first question an owner asks — would stop having an answer. Roles would stop meaning
-- anything too: cashier, supervisor and manager would all be the same login.
--
-- So the URL names the business and the PIN names the person in it. The experience is
-- still four digits; what changes is that the ledger keeps telling the truth.
--
-- ## Honest about the strength
--
-- Four digits is 10,000 possibilities. What makes that survivable is that the throttle is
-- per tenant, the PIN is useless without knowing which shop's URL to visit, and every
-- action is still gated by the permissions that member actually holds. It is a shop-floor
-- credential, appropriate to a till in a locked shop — not a remote-administration one.
-- =============================================================================

alter table tenant_memberships
  add column if not exists pin_hash        text,
  add column if not exists pin_set_at      timestamptz,
  add column if not exists pin_must_change boolean not null default false,
  add column if not exists last_login_at   timestamptz;

comment on column tenant_memberships.pin_hash is
  'bcrypt hash of this person''s shop PIN. Never plaintext, never sent to a client.';
comment on column tenant_memberships.pin_must_change is
  'Set when a PIN was issued by somebody else. Cleared once the person picks their own.';

-- -----------------------------------------------------------------------------
-- Per-tenant throttle
--
-- Scoped to the business on purpose. A global counter would let one attacker guessing at
-- one shop lock every other shop out of trading, which turns a nuisance into an outage
-- across the whole customer base.
--
-- The cost is that an attacker can stop one shop from selling. That is real, and it is the
-- lesser harm: a locked-out shop rings the owner, whereas a guessed PIN empties a till.
-- -----------------------------------------------------------------------------
create table tenant_pin_throttle (
  tenant_id            uuid primary key references tenants (id) on delete cascade,
  consecutive_failures integer not null default 0,
  locked_until         timestamptz,
  last_attempt_at      timestamptz
);

alter table tenant_pin_throttle enable row level security;
alter table tenant_pin_throttle force row level security;

-- Explicit refusal rather than no policy: the effect is the same, but an absent policy
-- reads as an oversight and nobody later can tell it was deliberate.
create policy tenant_pin_throttle_no_direct_access on tenant_pin_throttle
  for all to authenticated, anon
  using (false)
  with check (false);

comment on table tenant_pin_throttle is
  'Brute-force throttle per business. Reachable only through verify_member_pin.';

-- -----------------------------------------------------------------------------
-- verify_member_pin
--
-- Called before a session exists, so it cannot use auth.uid(), and is therefore executable
-- only by service_role. Granting it more widely would turn it into a public oracle for
-- guessing any shop's PIN.
--
-- Returns a status and never raises on a bad PIN: `raise` aborts the transaction, which
-- would roll back the failed-attempt counter and leave the throttle decorative.
-- -----------------------------------------------------------------------------
create or replace function verify_member_pin(p_tenant_slug text, p_pin text)
-- Output columns are prefixed because an OUT parameter named `tenant_id` shadows the table
-- column of the same name throughout the body, making every reference to it ambiguous.
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
    select tm.user_id as uid, p.email::text as mail, tm.pin_hash as hash,
           tm.pin_must_change as mustchg, tm.id as membership_id
    from public.tenant_memberships tm
    join public.profiles p on p.id = tm.user_id
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

revoke execute on function verify_member_pin(text, text) from public, anon, authenticated;
grant execute on function verify_member_pin(text, text) to service_role;

-- -----------------------------------------------------------------------------
-- app.pin_taken_in_tenant
--
-- Two people in the same shop must not share a PIN: with one credential opening two
-- identities, the ledger would attribute a sale to whichever row was scanned first, which
-- is exactly the attribution failure this whole design exists to avoid.
-- -----------------------------------------------------------------------------
create or replace function app.pin_taken_in_tenant(
  p_tenant_id uuid,
  p_pin       text,
  p_exclude_membership uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_memberships tm
    where tm.tenant_id = p_tenant_id
      and tm.pin_hash is not null
      and (p_exclude_membership is null or tm.id <> p_exclude_membership)
      and tm.pin_hash = extensions.crypt(p_pin, tm.pin_hash)
  )
$$;

-- -----------------------------------------------------------------------------
-- set_member_pin — a manager issuing a PIN to a member of staff
-- -----------------------------------------------------------------------------
create or replace function set_member_pin(p_membership_id uuid, p_pin text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_member record;
begin
  select tm.id, tm.tenant_id, tm.user_id into v_member
  from public.tenant_memberships tm
  where tm.id = p_membership_id;

  if not found then
    raise exception 'NOT_FOUND' using detail = 'That staff member does not exist.';
  end if;

  -- Issuing a credential is staff management, and is gated by the permission that governs
  -- it. A cashier cannot mint themselves a manager's PIN.
  if not app.has_permission(v_member.tenant_id, 'staff.manage') then
    raise exception 'PERMISSION_DENIED'
      using detail = 'You do not have permission to manage staff.';
  end if;

  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    raise exception 'VALIDATION_FAILED' using detail = 'A PIN is four digits.';
  end if;
  if p_pin ~ '^(.)\1{3}$' or p_pin in ('1234','4321','0123','9876','1024') then
    raise exception 'VALIDATION_FAILED' using detail = 'That PIN is too easy to guess.';
  end if;
  if app.pin_taken_in_tenant(v_member.tenant_id, p_pin, p_membership_id) then
    raise exception 'PIN_TAKEN'
      using detail = 'Somebody in this business already uses that PIN. Choose another.';
  end if;

  update public.tenant_memberships tm
     set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 12)),
         pin_set_at = now(),
         -- Issued by somebody else, so the holder is asked to choose their own on first use.
         pin_must_change = true
   where tm.id = p_membership_id;

  insert into public.audit_logs (tenant_id, actor_id, action, entity_type, entity_id, metadata)
  values (v_member.tenant_id, auth.uid(), 'STAFF_PIN_ISSUED', 'tenant_membership',
          p_membership_id, jsonb_build_object('issued_at', now()));
end;
$$;

-- -----------------------------------------------------------------------------
-- change_my_pin — a person choosing their own
-- -----------------------------------------------------------------------------
create or replace function change_my_pin(p_tenant_id uuid, p_current_pin text, p_new_pin text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_member record;
begin
  select tm.id, tm.pin_hash, tm.pin_must_change into v_member
  from public.tenant_memberships tm
  where tm.tenant_id = p_tenant_id
    and tm.user_id = auth.uid()
    and tm.status = 'ACTIVE';

  if not found then
    raise exception 'PERMISSION_DENIED' using detail = 'You are not a member of that business.';
  end if;
  if p_new_pin is null or p_new_pin !~ '^[0-9]{4}$' then
    raise exception 'VALIDATION_FAILED' using detail = 'A PIN is four digits.';
  end if;
  if p_new_pin ~ '^(.)\1{3}$' or p_new_pin in ('1234','4321','0123','9876','1024') then
    raise exception 'VALIDATION_FAILED' using detail = 'That PIN is too easy to guess.';
  end if;

  /*
   * The current PIN is required EXCEPT when the holder was told to change it.
   *
   * Somebody using a PIN a manager issued has just typed it to get here, so demanding it
   * again is ceremony. Once they own their PIN, changing it requires proving they know it —
   * otherwise anyone at an unattended till changes the cashier's credential.
   */
  if not v_member.pin_must_change then
    if v_member.pin_hash is null
       or v_member.pin_hash <> extensions.crypt(coalesce(p_current_pin, ''), v_member.pin_hash) then
      raise exception 'INVALID_PIN' using detail = 'The current PIN is not correct.';
    end if;
  end if;

  if app.pin_taken_in_tenant(p_tenant_id, p_new_pin, v_member.id) then
    raise exception 'PIN_TAKEN'
      using detail = 'Somebody in this business already uses that PIN. Choose another.';
  end if;

  update public.tenant_memberships tm
     set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 12)),
         pin_set_at = now(),
         pin_must_change = false
   where tm.id = v_member.id;

  -- Audited without either value. A credential recorded in a table many people can read is
  -- not a credential.
  insert into public.audit_logs (tenant_id, actor_id, action, entity_type, entity_id, metadata)
  values (p_tenant_id, auth.uid(), 'STAFF_PIN_CHANGED', 'tenant_membership', v_member.id,
          jsonb_build_object('changed_at', now()));
end;
$$;

revoke execute on function set_member_pin(uuid, text) from public, anon;
revoke execute on function change_my_pin(uuid, text, text) from public, anon;
grant execute on function set_member_pin(uuid, text) to authenticated;
grant execute on function change_my_pin(uuid, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- issue_initial_pin
--
-- The bridge between the two journeys: the platform owner finishes onboarding and needs
-- four digits to read out to the customer.
--
-- Kept separate from `onboard_client` rather than folded into it, because changing that
-- function's return type would mean dropping and recreating it — and a migration that
-- drops a working provisioning function to add a convenience is a bad trade.
--
-- The PIN is generated in the database and returned exactly once. It is never stored in
-- plaintext, so if the owner loses it before the customer uses it, the answer is to issue
-- another one rather than to look the old one up.
-- -----------------------------------------------------------------------------
create or replace function issue_initial_pin(p_tenant_id uuid)
returns table (out_pin text, out_email text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_membership record;
  v_pin        text;
  v_attempts   integer := 0;
begin
  if not app.is_platform_admin() then
    raise exception 'PERMISSION_DENIED'
      using detail = 'Only a platform administrator may issue a starting PIN.';
  end if;

  select tm.id, tm.user_id, p.email::text as email into v_membership
  from public.tenant_memberships tm
  join public.profiles p on p.id = tm.user_id
  where tm.tenant_id = p_tenant_id and tm.is_owner and tm.status = 'ACTIVE'
  limit 1;

  if not found then
    raise exception 'NOT_FOUND' using detail = 'That business has no owner.';
  end if;

  /*
   * A random PIN, not a sequence and not derived from anything about the business.
   * `gen_random_bytes` rather than random(): the latter is seeded per session and
   * predictable, which for a credential is the whole problem.
   *
   * Obvious values are rejected and redrawn, and the loop is bounded so a pathological
   * run cannot hang onboarding.
   */
  loop
    v_attempts := v_attempts + 1;
    v_pin := lpad(((get_byte(extensions.gen_random_bytes(2), 0) * 256
                    + get_byte(extensions.gen_random_bytes(2), 1)) % 10000)::text, 4, '0');
    exit when v_attempts > 20
      or (v_pin !~ '^(.)\1{3}$'
          and v_pin not in ('1234','4321','0123','9876','1024')
          and not app.pin_taken_in_tenant(p_tenant_id, v_pin, null));
  end loop;

  update public.tenant_memberships tm
     set pin_hash = extensions.crypt(v_pin, extensions.gen_salt('bf', 12)),
         pin_set_at = now(),
         -- Issued by somebody else, so the customer is asked to choose their own on first use.
         pin_must_change = true
   where tm.id = v_membership.id;

  -- Audited without the PIN.
  insert into public.audit_logs (tenant_id, actor_id, action, entity_type, entity_id, metadata)
  values (p_tenant_id, auth.uid(), 'STAFF_PIN_ISSUED', 'tenant_membership', v_membership.id,
          jsonb_build_object('initial', true));

  return query select v_pin, v_membership.email;
end;
$$;

revoke execute on function issue_initial_pin(uuid) from public, anon;
grant execute on function issue_initial_pin(uuid) to authenticated;

comment on function issue_initial_pin(uuid) is
  'Generates the customer''s starting PIN and returns it once. Platform administrators only.';
