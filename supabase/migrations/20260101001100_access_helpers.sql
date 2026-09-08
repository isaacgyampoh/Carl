-- =============================================================================
-- 0011 · Access helper functions
--
-- These are the functions every RLS policy is built on. Getting them right matters more
-- than any single policy, because a mistake here is inherited by all of them.
--
-- ## Three properties every helper must have
--
-- ### 1. SECURITY DEFINER
--
-- A policy on `tenant_memberships` that queries `tenant_memberships` to decide who may
-- read it recurses infinitely. PostgreSQL detects this and errors, but the more common
-- outcome is a policy written to avoid the recursion by being too permissive.
--
-- Running the helpers as their owner lets them read membership tables directly, without
-- re-entering the policies that call them.
--
-- ### 2. `set search_path = ''`
--
-- A SECURITY DEFINER function runs with the owner's privileges. If it resolves an
-- unqualified name through the caller's search_path, a caller who creates their own
-- `public.tenant_memberships` can make the function read their table instead — and grant
-- themselves any tenant they like. Every identifier below is fully qualified and the
-- search path is empty, which closes that entirely.
--
-- ### 3. STABLE, and called as `(select ...)` in policies
--
-- A policy predicate is evaluated per row. A volatile function would re-query membership
-- for every row of a 50,000-row sales scan. Marking these STABLE and wrapping calls as
-- `(select app.…)` lets PostgreSQL hoist them into an InitPlan evaluated **once per
-- statement** — the difference between a POS that responds instantly and one that does
-- not.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Identity
-- -----------------------------------------------------------------------------

create or replace function app.current_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid()
$$;

comment on function app.current_user_id() is
  'The authenticated user, from the verified JWT. Never from a request body or parameter.';

-- Administers the Carl platform. Deliberately NOT a master key over tenant data:
-- app.can_read_tenant() requires a support grant as well. See migration 0009.
-- Reads `platform_admins`, never `profiles`.
--
-- That is load-bearing: `profiles` has a policy that calls this function, and a function
-- reading the same table its caller's policy protects is infinite recursion. Keeping the
-- flag in a separate table whose own policy does not call back here breaks the cycle.
create or replace function app.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
$$;

comment on function app.is_platform_admin() is
  'Administers the platform. Does not by itself grant access to any tenant''s business data.';

-- -----------------------------------------------------------------------------
-- Tenant membership
-- -----------------------------------------------------------------------------

create or replace function app.is_tenant_member(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_memberships m
    where m.tenant_id = p_tenant_id
      and m.user_id = auth.uid()
      and m.status = 'ACTIVE'
  )
$$;

comment on function app.is_tenant_member(uuid) is
  'Active membership only. An INVITED, SUSPENDED or REMOVED member reaches nothing.';

create or replace function app.current_tenant_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.tenant_id), array[]::uuid[])
  from public.tenant_memberships m
  where m.user_id = auth.uid()
    and m.status = 'ACTIVE'
$$;

-- -----------------------------------------------------------------------------
-- Tenant standing
--
-- A suspended or cancelled tenant may still READ its data — a business locked out for
-- non-payment must still be able to see its own records, and withholding them is both
-- hostile and, for tax records, legally fraught. It may not WRITE.
--
-- This split is why write policies call app.can_write_tenant() while read policies call
-- app.is_tenant_member().
-- -----------------------------------------------------------------------------

create or replace function app.tenant_can_transact(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenants t
    where t.id = p_tenant_id
      and t.status in ('TRIAL', 'ACTIVE', 'GRACE_PERIOD')
  )
$$;

comment on function app.tenant_can_transact(uuid) is
  'Whether a tenant may write. Suspended and cancelled tenants keep read access to their own records.';

create or replace function app.can_write_tenant(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.is_tenant_member(p_tenant_id) and app.tenant_can_transact(p_tenant_id)
$$;

-- -----------------------------------------------------------------------------
-- Branch scoping
--
-- A membership with no rows in membership_branches has tenant-wide access. That is the
-- right default for an owner or administrator, and avoids fanning out a row per branch
-- every time a branch is created. Rows present restrict the member to exactly those.
-- -----------------------------------------------------------------------------

create or replace function app.can_access_branch(p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.branches b
    join public.tenant_memberships m
      on m.tenant_id = b.tenant_id
     and m.user_id = auth.uid()
     and m.status = 'ACTIVE'
    where b.id = p_branch_id
      and (
        -- Unrestricted membership: tenant-wide access.
        not exists (select 1 from public.membership_branches mb where mb.membership_id = m.id)
        -- Otherwise the branch must be explicitly assigned.
        or exists (
          select 1 from public.membership_branches mb
          where mb.membership_id = m.id and mb.branch_id = b.id
        )
      )
  )
$$;

comment on function app.can_access_branch(uuid) is
  'No membership_branches rows means tenant-wide access; rows present restrict to exactly those branches.';

create or replace function app.accessible_branch_ids(p_tenant_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(b.id), array[]::uuid[])
  from public.branches b
  join public.tenant_memberships m
    on m.tenant_id = b.tenant_id
   and m.user_id = auth.uid()
   and m.status = 'ACTIVE'
  where b.tenant_id = p_tenant_id
    and (
      not exists (select 1 from public.membership_branches mb where mb.membership_id = m.id)
      or exists (
        select 1 from public.membership_branches mb
        where mb.membership_id = m.id and mb.branch_id = b.id
      )
    )
$$;

-- -----------------------------------------------------------------------------
-- Permissions
--
-- Resolves through membership -> membership_roles -> role_permissions.
--
-- A role granted with a branch applies only in that branch; a role granted with
-- branch_id NULL applies tenant-wide. Passing p_branch_id NULL asks "does this user hold
-- the permission anywhere in the tenant", which is what a navigation check wants; passing
-- a branch asks whether they hold it *there*, which is what an operation must ask.
-- -----------------------------------------------------------------------------

create or replace function app.has_permission(
  p_tenant_id uuid,
  p_permission text,
  p_branch_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_memberships m
    join public.membership_roles mr on mr.membership_id = m.id
    join public.role_permissions rp on rp.role_id = mr.role_id
    where m.tenant_id = p_tenant_id
      and m.user_id = auth.uid()
      and m.status = 'ACTIVE'
      and rp.permission_key = p_permission
      and (
        -- A tenant-wide grant applies everywhere.
        mr.branch_id is null
        -- A branch-scoped grant applies only there. When no branch is specified the
        -- question is "anywhere", so a branch-scoped grant counts.
        or p_branch_id is null
        or mr.branch_id = p_branch_id
      )
  )
$$;

comment on function app.has_permission(uuid, text, uuid) is
  'Resolves a permission through membership, roles and grants. NULL branch asks "anywhere in the tenant".';

-- The strongest (numerically lowest) role rank the caller holds in a tenant.
--
-- This exists as a function rather than an inline subquery for a concrete reason: a policy
-- on `membership_roles` cannot itself contain `select ... from membership_roles`. The
-- query rewriter rejects that as infinite recursion (42P17) before it ever runs. A
-- SECURITY DEFINER function is opaque to the rewriter and bypasses RLS, so the same logic
-- expressed here works.
--
-- Returns the maximum smallint when the caller holds no role at all, so a roleless user
-- can grant nothing rather than everything.
create or replace function app.strongest_role_rank(p_tenant_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select min(r.rank)::integer
      from public.tenant_memberships m
      join public.membership_roles mr on mr.membership_id = m.id
      join public.roles r on r.id = mr.role_id
      where m.tenant_id = p_tenant_id
        and m.user_id = auth.uid()
        and m.status = 'ACTIVE'
    ),
    2147483647
  )
$$;

comment on function app.strongest_role_rank(uuid) is
  'Lowest rank the caller holds in a tenant. Stops anyone granting a role stronger than their own.';

-- The owner of a tenant, who cannot be removed by other members.
create or replace function app.is_tenant_owner(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_memberships m
    where m.tenant_id = p_tenant_id
      and m.user_id = auth.uid()
      and m.status = 'ACTIVE'
      and m.is_owner
  )
$$;

-- -----------------------------------------------------------------------------
-- Support access
--
-- The only route by which Carl staff may read a customer's business data, and it
-- requires a live, unrevoked, unexpired grant naming them.
-- -----------------------------------------------------------------------------

create or replace function app.has_support_access(p_tenant_id uuid, p_write boolean default false)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_support_grants g
    join public.platform_admins pa on pa.user_id = g.grantee_id
    where g.tenant_id = p_tenant_id
      and g.grantee_id = auth.uid()
      and g.revoked_at is null
      and g.expires_at > now()
      and (not p_write or g.allow_write)
  )
$$;

comment on function app.has_support_access(uuid, boolean) is
  'A live, time-boxed support grant. The only way platform staff reach tenant business data.';

create or replace function app.can_read_tenant(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.is_tenant_member(p_tenant_id) or app.has_support_access(p_tenant_id, false)
$$;

-- -----------------------------------------------------------------------------
-- The single predicate behind every tenant-owned read policy.
--
-- It collapses what would otherwise be three separate conditions repeated across dozens of
-- policies - membership, permission, branch access - into one, and handles the case they
-- kept getting wrong: a support engineer.
--
-- A support grantee is not a member and holds no role, so a permission check can never
-- pass for them. Expressed as `member AND permission`, a support grant would grant
-- nothing at all. The grant itself is the authorisation, and it is already narrow:
-- read-only, reasoned, audited, and expiring within seven days.
-- -----------------------------------------------------------------------------
create or replace function app.can_read(
  p_tenant_id uuid,
  p_permission text,
  p_branch_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (
    app.is_tenant_member(p_tenant_id)
    and app.has_permission(p_tenant_id, p_permission, p_branch_id)
    and (p_branch_id is null or app.can_access_branch(p_branch_id))
  )
  or app.has_support_access(p_tenant_id, false)
$$;

comment on function app.can_read(uuid, text, uuid) is
  'Membership + permission + branch access, or a live support grant. The predicate for tenant-owned reads.';

-- -----------------------------------------------------------------------------
-- Grants
--
-- EXECUTE is granted to `authenticated` because RLS policies are evaluated as the
-- calling role and must be able to run these. It is NOT granted to `anon`: an
-- unauthenticated caller has nothing to evaluate and should not be able to probe
-- membership through timing.
-- -----------------------------------------------------------------------------

grant execute on all functions in schema app to authenticated;
revoke execute on all functions in schema app from anon;
revoke execute on all functions in schema app from public;
