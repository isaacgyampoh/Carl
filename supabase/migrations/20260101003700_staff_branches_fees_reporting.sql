-- =============================================================================
-- 0037 · Staff management, branches, per-client fees, period reporting
--
-- A business could be onboarded but could not run itself: nothing let its owner add a
-- cashier, open a second branch, or see more than today's takings, and the platform owner
-- could not change what a client pays after onboarding.
--
-- ## Two security holes closed on the way
--
-- 1. `set_member_pin` checked only `staff.manage`. A branch manager holds that, so they
--    could reset a tenant administrator's PIN, learn it, and sign in as the administrator.
--    It now refuses to touch the owner or anyone holding a stronger role than the caller.
--
-- 2. Adding staff needs a SECURITY DEFINER function, because `profiles` has no INSERT
--    policy. A function that accepted any user id would let a client owner attach ANOTHER
--    business's owner to their own shop, set a PIN they know, and sign in as that person.
--    `add_staff_member` therefore attaches only a brand-new account: created in the last
--    fifteen minutes, with no profile, no membership anywhere, and no platform role. Its
--    email is read from `auth.users`, never from the caller.
--
-- Every SECURITY DEFINER function below re-states the rules RLS would have applied —
-- tenant writability, the permission, and the rank guard from `membership_roles_write` —
-- because running as the owner bypasses RLS entirely. All pin `search_path = ''`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The strongest (numerically lowest) rank a membership holds. Pairs with
-- app.strongest_role_rank(), which answers the same question for the caller.
-- -----------------------------------------------------------------------------
create or replace function app.membership_strongest_rank(p_membership_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select min(r.rank)::integer
      from public.membership_roles mr
      join public.roles r on r.id = mr.role_id
      where mr.membership_id = p_membership_id
    ),
    2147483647
  )
$$;

comment on function app.membership_strongest_rank(uuid) is
  'Lowest role rank a membership holds. A member with no role is treated as the weakest.';

-- -----------------------------------------------------------------------------
-- The shared guard for acting on an existing member of staff.
--
-- Refuses the business owner, the caller themselves, and anyone holding a role stronger
-- than the caller's — the same `rank >=` rule `membership_roles_write` enforces.
-- -----------------------------------------------------------------------------
create or replace function app.assert_can_manage_member(
  p_membership_id uuid,
  p_permission    text
)
returns public.tenant_memberships
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_member public.tenant_memberships;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED' using detail = 'Sign in first.';
  end if;

  select * into v_member from public.tenant_memberships tm where tm.id = p_membership_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'That staff member does not exist.';
  end if;

  if not app.can_write_tenant(v_member.tenant_id) then
    raise exception 'PERMISSION_DENIED' using detail = 'This business cannot be changed right now.';
  end if;
  if not app.has_permission(v_member.tenant_id, p_permission) then
    raise exception 'PERMISSION_DENIED' using detail = 'You do not have permission to manage staff.';
  end if;
  if v_member.is_owner then
    raise exception 'PERMISSION_DENIED' using detail = 'The business owner cannot be changed here.';
  end if;
  if v_member.user_id = auth.uid() then
    raise exception 'PERMISSION_DENIED' using detail = 'You cannot change your own access.';
  end if;
  if app.membership_strongest_rank(v_member.id) < app.strongest_role_rank(v_member.tenant_id) then
    raise exception 'PERMISSION_DENIED'
      using detail = 'That person holds more authority than you do.';
  end if;

  return v_member;
end;
$$;

-- -----------------------------------------------------------------------------
-- A PIN a business will accept. Shared so every issuing path applies the same rules.
-- -----------------------------------------------------------------------------
create or replace function app.assert_acceptable_pin(
  p_tenant_id uuid,
  p_pin       text,
  p_exclude_membership uuid default null
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    raise exception 'VALIDATION_FAILED' using detail = 'A PIN is four digits.';
  end if;
  if p_pin ~ '^(.)\1{3}$' or p_pin in ('1234','4321','0123','9876','1024') then
    raise exception 'VALIDATION_FAILED' using detail = 'That PIN is too easy to guess.';
  end if;
  -- The PIN identifies the person inside a business, so two people cannot share one.
  if app.pin_taken_in_tenant(p_tenant_id, p_pin, p_exclude_membership) then
    raise exception 'PIN_TAKEN'
      using detail = 'Somebody in this business already uses that PIN. Choose another.';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- add_staff_member
-- -----------------------------------------------------------------------------
create or replace function add_staff_member(
  p_tenant_id  uuid,
  p_user_id    uuid,
  p_full_name  text,
  p_role_key   text,
  p_pin        text,
  p_branch_ids uuid[] default null,
  p_job_title  text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role          record;
  v_email         text;
  v_membership_id uuid;
  v_branch        uuid;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED' using detail = 'Sign in first.';
  end if;
  if not app.can_write_tenant(p_tenant_id) then
    raise exception 'PERMISSION_DENIED' using detail = 'This business cannot be changed right now.';
  end if;
  -- Both, as RLS requires: staff.manage to create the membership, roles.manage to give it
  -- a role. A branch manager holds only the first.
  if not (app.has_permission(p_tenant_id, 'staff.manage')
          and app.has_permission(p_tenant_id, 'roles.manage')) then
    raise exception 'PERMISSION_DENIED' using detail = 'You do not have permission to add staff.';
  end if;

  if p_full_name is null or length(btrim(p_full_name)) < 2 then
    raise exception 'VALIDATION_FAILED' using detail = 'Give the staff member a name.';
  end if;

  select r.id, r.key, r.rank into v_role
  from public.roles r
  where r.tenant_id = p_tenant_id and r.key = p_role_key;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'That role does not exist in this business.';
  end if;
  if v_role.key = 'tenant_owner' then
    raise exception 'PERMISSION_DENIED'
      using detail = 'A business has one owner, set when the business is created.';
  end if;
  if v_role.rank < app.strongest_role_rank(p_tenant_id) then
    raise exception 'PERMISSION_DENIED'
      using detail = 'You cannot give someone more authority than you hold.';
  end if;

  /*
   * Only a brand-new account may be attached. See the header: otherwise a client owner
   * could attach another business's owner here and sign in as them with a PIN they chose.
   */
  select u.email::text into v_email
  from auth.users u
  where u.id = p_user_id
    and u.created_at > now() - interval '15 minutes';
  if v_email is null then
    raise exception 'PERMISSION_DENIED' using detail = 'That account cannot be added as staff.';
  end if;
  if exists (select 1 from public.profiles p where p.id = p_user_id)
     or exists (select 1 from public.tenant_memberships m where m.user_id = p_user_id)
     or exists (select 1 from public.platform_admins a where a.user_id = p_user_id) then
    raise exception 'PERMISSION_DENIED' using detail = 'That account cannot be added as staff.';
  end if;

  if p_branch_ids is not null then
    foreach v_branch in array p_branch_ids loop
      if not exists (
        select 1 from public.branches b
        where b.id = v_branch and b.tenant_id = p_tenant_id and b.is_active
      ) or not app.can_access_branch(v_branch) then
        raise exception 'PERMISSION_DENIED' using detail = 'A branch does not belong to this business.';
      end if;
    end loop;
  end if;

  perform app.assert_acceptable_pin(p_tenant_id, p_pin, null);

  insert into public.profiles (id, email, full_name)
  values (p_user_id, v_email, btrim(p_full_name));

  insert into public.tenant_memberships (
    tenant_id, user_id, status, is_owner, job_title,
    invited_by, invited_at, accepted_at,
    pin_hash, pin_set_at, pin_must_change
  )
  values (
    p_tenant_id, p_user_id, 'ACTIVE', false, nullif(btrim(coalesce(p_job_title, '')), ''),
    auth.uid(), now(), now(),
    -- Issued by a manager, so the holder is asked to choose their own on first use.
    extensions.crypt(p_pin, extensions.gen_salt('bf', 12)), now(), true
  )
  returning id into v_membership_id;

  insert into public.membership_roles (membership_id, role_id, branch_id)
  values (v_membership_id, v_role.id, null);

  -- No rows means every branch, which is the existing rule in app.can_access_branch().
  if p_branch_ids is not null and cardinality(p_branch_ids) > 0 then
    insert into public.membership_branches (membership_id, branch_id)
    select v_membership_id, b from unnest(p_branch_ids) as b;
  end if;

  insert into public.audit_logs (tenant_id, actor_id, action, entity_type, entity_id, metadata)
  values (p_tenant_id, auth.uid(), 'STAFF_ADDED', 'tenant_membership', v_membership_id,
          jsonb_build_object('role', v_role.key,
                             'branches', coalesce(cardinality(p_branch_ids), 0)));

  return v_membership_id;
end;
$$;

revoke execute on function add_staff_member(uuid, uuid, text, text, text, uuid[], text)
  from public, anon;
grant execute on function add_staff_member(uuid, uuid, text, text, text, uuid[], text)
  to authenticated;

comment on function add_staff_member(uuid, uuid, text, text, text, uuid[], text) is
  'Adds a member of staff with a role, branches and an issued PIN. Attaches only a brand-new account. Requires staff.manage and roles.manage; cannot grant a role stronger than the caller''s.';

-- -----------------------------------------------------------------------------
-- set_staff_role
-- -----------------------------------------------------------------------------
create or replace function set_staff_role(p_membership_id uuid, p_role_key text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_member public.tenant_memberships;
  v_role   record;
begin
  v_member := app.assert_can_manage_member(p_membership_id, 'roles.manage');

  select r.id, r.key, r.rank into v_role
  from public.roles r
  where r.tenant_id = v_member.tenant_id and r.key = p_role_key;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'That role does not exist in this business.';
  end if;
  if v_role.key = 'tenant_owner' or v_role.rank < app.strongest_role_rank(v_member.tenant_id) then
    raise exception 'PERMISSION_DENIED'
      using detail = 'You cannot give someone more authority than you hold.';
  end if;

  delete from public.membership_roles mr where mr.membership_id = p_membership_id;
  insert into public.membership_roles (membership_id, role_id, branch_id)
  values (p_membership_id, v_role.id, null);

  insert into public.audit_logs (tenant_id, actor_id, action, entity_type, entity_id, metadata)
  values (v_member.tenant_id, auth.uid(), 'STAFF_ROLE_CHANGED', 'tenant_membership',
          p_membership_id, jsonb_build_object('role', v_role.key));
end;
$$;

revoke execute on function set_staff_role(uuid, text) from public, anon;
grant execute on function set_staff_role(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- set_staff_branches
-- -----------------------------------------------------------------------------
create or replace function set_staff_branches(p_membership_id uuid, p_branch_ids uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_member public.tenant_memberships;
  v_branch uuid;
begin
  v_member := app.assert_can_manage_member(p_membership_id, 'staff.manage');

  if p_branch_ids is not null then
    foreach v_branch in array p_branch_ids loop
      if not exists (
        select 1 from public.branches b
        where b.id = v_branch and b.tenant_id = v_member.tenant_id and b.is_active
      ) or not app.can_access_branch(v_branch) then
        raise exception 'PERMISSION_DENIED' using detail = 'A branch does not belong to this business.';
      end if;
    end loop;
  end if;

  delete from public.membership_branches mb where mb.membership_id = p_membership_id;
  if p_branch_ids is not null and cardinality(p_branch_ids) > 0 then
    insert into public.membership_branches (membership_id, branch_id)
    select p_membership_id, b from unnest(p_branch_ids) as b;
  end if;

  insert into public.audit_logs (tenant_id, actor_id, action, entity_type, entity_id, metadata)
  values (v_member.tenant_id, auth.uid(), 'STAFF_BRANCHES_CHANGED', 'tenant_membership',
          p_membership_id, jsonb_build_object('branches', coalesce(cardinality(p_branch_ids), 0)));
end;
$$;

revoke execute on function set_staff_branches(uuid, uuid[]) from public, anon;
grant execute on function set_staff_branches(uuid, uuid[]) to authenticated;

-- -----------------------------------------------------------------------------
-- set_staff_status — suspend, reactivate or remove
-- -----------------------------------------------------------------------------
create or replace function set_staff_status(p_membership_id uuid, p_status text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_member public.tenant_memberships;
begin
  if p_status not in ('ACTIVE', 'SUSPENDED', 'REMOVED') then
    raise exception 'VALIDATION_FAILED' using detail = 'Unknown staff status.';
  end if;

  v_member := app.assert_can_manage_member(p_membership_id, 'staff.manage');

  update public.tenant_memberships tm
     set status       = p_status::public.membership_status,
         suspended_at = case when p_status = 'SUSPENDED' then now() else null end,
         removed_at   = case when p_status = 'REMOVED' then now() else tm.removed_at end
   where tm.id = p_membership_id;

  insert into public.audit_logs (tenant_id, actor_id, action, entity_type, entity_id, metadata)
  values (v_member.tenant_id, auth.uid(), 'STAFF_STATUS_CHANGED', 'tenant_membership',
          p_membership_id, jsonb_build_object('status', p_status));
end;
$$;

revoke execute on function set_staff_status(uuid, text) from public, anon;
grant execute on function set_staff_status(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- set_member_pin — replaced, with the escalation guard
-- -----------------------------------------------------------------------------
create or replace function set_member_pin(p_membership_id uuid, p_pin text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_member public.tenant_memberships;
begin
  /*
   * The guard is the fix. Previously only `staff.manage` was checked, so a branch manager
   * could issue a PIN to a tenant administrator — and a PIN you issued is a PIN you know.
   */
  v_member := app.assert_can_manage_member(p_membership_id, 'staff.manage');

  perform app.assert_acceptable_pin(v_member.tenant_id, p_pin, p_membership_id);

  update public.tenant_memberships tm
     set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 12)),
         pin_set_at = now(),
         pin_must_change = true
   where tm.id = p_membership_id;

  insert into public.audit_logs (tenant_id, actor_id, action, entity_type, entity_id, metadata)
  values (v_member.tenant_id, auth.uid(), 'STAFF_PIN_ISSUED', 'tenant_membership',
          p_membership_id, jsonb_build_object('issued_at', now()));
end;
$$;

revoke execute on function set_member_pin(uuid, text) from public, anon;
grant execute on function set_member_pin(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- create_branch — a branch and its register, together
-- -----------------------------------------------------------------------------
create or replace function create_branch(
  p_tenant_id uuid,
  p_name      text,
  p_code      text,
  p_address   text default null,
  p_phone     text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_branch_id uuid;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED' using detail = 'Sign in first.';
  end if;
  if not app.can_write_tenant(p_tenant_id) then
    raise exception 'PERMISSION_DENIED' using detail = 'This business cannot be changed right now.';
  end if;
  if not app.has_permission(p_tenant_id, 'branches.manage') then
    raise exception 'PERMISSION_DENIED' using detail = 'You do not have permission to add branches.';
  end if;
  if p_name is null or length(btrim(p_name)) < 2 then
    raise exception 'VALIDATION_FAILED' using detail = 'Give the branch a name.';
  end if;
  if p_code is null or btrim(p_code) !~ '^[a-z0-9][a-z0-9-]{0,19}$' then
    raise exception 'VALIDATION_FAILED'
      using detail = 'A branch code is lowercase letters, numbers and hyphens.';
  end if;

  begin
    insert into public.branches (tenant_id, code, name, address, phone, is_default, is_active)
    values (p_tenant_id, btrim(p_code), btrim(p_name), nullif(btrim(coalesce(p_address, '')), ''),
            nullif(btrim(coalesce(p_phone, '')), ''), false, true)
    returning id into v_branch_id;
  exception when unique_violation then
    raise exception 'CONFLICT' using detail = 'Another branch already uses that code.';
  end;

  -- A branch with no register cannot open a cash session, so it could not sell.
  insert into public.cash_registers (tenant_id, branch_id, name)
  values (p_tenant_id, v_branch_id, 'Main register');

  insert into public.audit_logs (tenant_id, actor_id, action, entity_type, entity_id, metadata)
  values (p_tenant_id, auth.uid(), 'BRANCH_CREATED', 'branch', v_branch_id,
          jsonb_build_object('code', btrim(p_code)));

  return v_branch_id;
end;
$$;

revoke execute on function create_branch(uuid, text, text, text, text) from public, anon;
grant execute on function create_branch(uuid, text, text, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- set_client_monthly_fee — the platform owner's agreed price for one client
-- -----------------------------------------------------------------------------
create or replace function set_client_monthly_fee(
  p_tenant_id uuid,
  p_price     bigint,
  p_note      text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_subscription_id uuid;
  v_old_price       bigint;
begin
  if not app.is_platform_admin() then
    raise exception 'PERMISSION_DENIED'
      using detail = 'Only the platform owner can change what a client pays.';
  end if;
  if p_price is null or p_price < 0 then
    raise exception 'VALIDATION_FAILED' using detail = 'The fee cannot be negative.';
  end if;

  select s.id, s.price into v_subscription_id, v_old_price
  from public.subscriptions s
  where s.tenant_id = p_tenant_id and s.cancelled_at is null
  order by s.created_at desc
  limit 1
  for update;

  if v_subscription_id is null then
    raise exception 'NOT_FOUND' using detail = 'That client has no active subscription.';
  end if;

  update public.subscriptions s
     set price = p_price,
         notes = case when nullif(btrim(coalesce(p_note, '')), '') is null then s.notes
                      else btrim(p_note) end,
         updated_at = now()
   where s.id = v_subscription_id;

  insert into public.audit_logs (tenant_id, actor_id, action, entity_type, entity_id, metadata)
  values (p_tenant_id, auth.uid(), 'CLIENT_FEE_CHANGED', 'subscription', v_subscription_id,
          jsonb_build_object('old_price', v_old_price, 'new_price', p_price));
end;
$$;

revoke execute on function set_client_monthly_fee(uuid, bigint, text) from public, anon;
grant execute on function set_client_monthly_fee(uuid, bigint, text) to authenticated;

-- -----------------------------------------------------------------------------
-- tenant_sales_periods — today, this week, this month, this year in one pass
--
-- SECURITY INVOKER, so RLS decides what counts: a cashier's totals are their own sales,
-- an accountant's are the business's. One index range scan over the year, filtered four
-- ways, rather than four queries.
-- -----------------------------------------------------------------------------
create or replace function tenant_sales_periods(p_tenant_id uuid, p_branch_id uuid default null)
returns table (
  today_count bigint, today_gross bigint,
  week_count  bigint, week_gross  bigint,
  month_count bigint, month_gross bigint,
  year_count  bigint, year_gross  bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with zone as (
    select coalesce((select t.timezone from public.tenants t where t.id = p_tenant_id), 'UTC') as tz
  ),
  -- The business's own local calendar, converted back to instants.
  bounds as (
    select
      date_trunc('day',   now() at time zone z.tz) at time zone z.tz as day_start,
      date_trunc('week',  now() at time zone z.tz) at time zone z.tz as week_start,
      date_trunc('month', now() at time zone z.tz) at time zone z.tz as month_start,
      date_trunc('year',  now() at time zone z.tz) at time zone z.tz as year_start
    from zone z
  )
  /*
   * `count(s.id)`, never `count(*)`. This is a LEFT JOIN from a single row of date bounds,
   * so with no matching sales the join still produces one row — and `count(*)` counted it,
   * reporting one sale for a business that had made none. Counting the sale's id counts only
   * real sales.
   */
  select
    count(s.id)    filter (where s.sold_at >= b.day_start),
    coalesce(sum(s.total) filter (where s.sold_at >= b.day_start), 0)::bigint,
    count(s.id)    filter (where s.sold_at >= b.week_start),
    coalesce(sum(s.total) filter (where s.sold_at >= b.week_start), 0)::bigint,
    count(s.id)    filter (where s.sold_at >= b.month_start),
    coalesce(sum(s.total) filter (where s.sold_at >= b.month_start), 0)::bigint,
    count(s.id),
    coalesce(sum(s.total), 0)::bigint
  from bounds b
  left join public.sales s
    on s.tenant_id = p_tenant_id
   and (p_branch_id is null or s.branch_id = p_branch_id)
   and s.status <> 'VOIDED'
   and s.sold_at >= b.year_start
$$;

revoke execute on function tenant_sales_periods(uuid, uuid) from public, anon;
grant execute on function tenant_sales_periods(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- inventory_overview and low_stock_items
--
-- PostgREST cannot compare two columns in a filter, so "quantity at or below its reorder
-- level" needs a function. SECURITY INVOKER: rows are the caller's per inventory.view.
-- -----------------------------------------------------------------------------
create or replace function inventory_overview(p_tenant_id uuid, p_branch_id uuid default null)
returns table (products bigint, low_stock bigint, out_of_stock bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    (select count(*) from public.products p where p.tenant_id = p_tenant_id and p.is_active),
    (select count(*) from public.inventory i
       join public.products p on p.id = i.product_id and p.is_active and p.is_stock_tracked
      where i.tenant_id = p_tenant_id
        and (p_branch_id is null or i.branch_id = p_branch_id)
        and i.quantity > 0 and i.quantity <= i.reorder_level),
    (select count(*) from public.inventory i
       join public.products p on p.id = i.product_id and p.is_active and p.is_stock_tracked
      where i.tenant_id = p_tenant_id
        and (p_branch_id is null or i.branch_id = p_branch_id)
        and i.quantity <= 0)
$$;

revoke execute on function inventory_overview(uuid, uuid) from public, anon;
grant execute on function inventory_overview(uuid, uuid) to authenticated;

create or replace function low_stock_items(
  p_tenant_id uuid,
  p_branch_id uuid default null,
  p_limit     integer default 10
)
returns table (
  product_id    uuid,
  name          text,
  sku           text,
  branch_id     uuid,
  quantity      numeric,
  reorder_level numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select p.id, p.name, p.sku, i.branch_id, i.quantity, i.reorder_level
  from public.inventory i
  join public.products p on p.id = i.product_id and p.is_active and p.is_stock_tracked
  where i.tenant_id = p_tenant_id
    and (p_branch_id is null or i.branch_id = p_branch_id)
    and i.quantity <= i.reorder_level
  order by (i.quantity - i.reorder_level), p.name
  limit least(greatest(coalesce(p_limit, 10), 1), 100)
$$;

revoke execute on function low_stock_items(uuid, uuid, integer) from public, anon;
grant execute on function low_stock_items(uuid, uuid, integer) to authenticated;
