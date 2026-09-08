-- =============================================================================
-- 0002 · Roles and permissions
--
-- ## Why permissions are rows, not an enum on a role
--
-- Businesses do not share one hierarchy. A pharmacy needs someone who can adjust stock
-- but never discount; a fuel station needs the reverse. Hard-coding permissions against
-- a role enum makes every such request a schema migration and a redeploy.
--
-- Roles are therefore per-tenant rows, seeded from the system templates in
-- packages/domain/src/access/roles.ts, and their permissions live in a join table that a
-- tenant administrator can edit.
--
-- ## Where permissions are enforced
--
-- Here, in the database. app.has_permission() is called by RLS policies and by every
-- transactional function. The UI reads the same set only to avoid presenting a cashier
-- with a refund button that will refuse them. Hiding a button is not access control.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- permissions — the catalogue
--
-- Global, not per-tenant: the set of things Carl can authorise is a property of the
-- software. Seeded from packages/domain/src/access/permissions.ts, and a database test
-- asserts the two never drift.
-- -----------------------------------------------------------------------------

create table permissions (
  key         text primary key,
  resource    text not null,
  action      text not null,
  description text not null,
  created_at  timestamptz not null default now(),

  constraint permissions_key_format check (key ~ '^[a-z_]+\.[a-z_]+$'),
  constraint permissions_key_matches_parts check (key = resource || '.' || action)
);

create index permissions_resource_idx on permissions (resource);

comment on table permissions is
  'The catalogue of authorisable actions. Global, seeded from @carl/domain; never tenant-specific.';

-- -----------------------------------------------------------------------------
-- roles — per tenant
-- -----------------------------------------------------------------------------

create table roles (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  key         app.slug not null,
  name        app.label not null,
  description text,

  -- Lower binds more authority. Used to stop a manager granting a role above their own,
  -- which is the simplest route to privilege escalation in any RBAC system.
  rank        smallint not null default 50,

  -- System roles are provisioned with the tenant and cannot be deleted; their permissions
  -- may still be edited, because a business's idea of "cashier" is its own.
  is_system   boolean not null default false,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint roles_rank_range check (rank between 0 and 100)
);

create unique index roles_tenant_key_key on roles (tenant_id, key);
create index roles_tenant_idx on roles (tenant_id);

comment on column roles.rank is
  'Lower binds more authority. Prevents a user granting a role stronger than their own.';

create trigger roles_touch_updated_at
  before update on roles
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- role_permissions
-- -----------------------------------------------------------------------------

create table role_permissions (
  role_id        uuid not null references roles (id) on delete cascade,
  permission_key text not null references permissions (key) on delete cascade,
  granted_at     timestamptz not null default now(),
  granted_by     uuid references profiles (id) on delete set null,

  primary key (role_id, permission_key)
);

create index role_permissions_permission_idx on role_permissions (permission_key);

-- -----------------------------------------------------------------------------
-- membership_roles
--
-- A member may hold several roles, and a role may be granted tenant-wide or only within
-- one branch. Branch-scoped roles are what let one person be a manager in Accra and an
-- ordinary cashier in Kumasi - a real arrangement that a single role column cannot model.
-- -----------------------------------------------------------------------------

create table membership_roles (
  id            uuid primary key default gen_random_uuid(),
  membership_id uuid not null references tenant_memberships (id) on delete cascade,
  role_id       uuid not null references roles (id) on delete cascade,

  -- NULL means the role applies across the whole tenant.
  branch_id     uuid references branches (id) on delete cascade,

  granted_by    uuid references profiles (id) on delete set null,
  granted_at    timestamptz not null default now()
);

-- A role may be held once tenant-wide and once per branch, but not twice identically.
-- Two indexes because NULL branch_id would otherwise defeat a single unique constraint.
create unique index membership_roles_scoped_key
  on membership_roles (membership_id, role_id, branch_id)
  where branch_id is not null;

create unique index membership_roles_tenant_wide_key
  on membership_roles (membership_id, role_id)
  where branch_id is null;

create index membership_roles_membership_idx on membership_roles (membership_id);
create index membership_roles_role_idx on membership_roles (role_id);

comment on column membership_roles.branch_id is
  'NULL means the role applies tenant-wide. Set to scope it to one branch.';

-- -----------------------------------------------------------------------------
-- Cross-tenant integrity
--
-- Foreign keys guarantee that a referenced row exists - not that it belongs to the same
-- tenant. Without the check below, a membership in tenant A could be granted a role
-- belonging to tenant B: every individual foreign key is satisfied, and the result is a
-- complete authorization bypass.
--
-- This class of bug is invisible to code review and is not caught by RLS, because RLS
-- filters rows rather than validating relationships between them. It is enforced here.
-- -----------------------------------------------------------------------------

-- These integrity triggers are SECURITY DEFINER deliberately.
--
-- A trigger that reads through RLS validates against a *filtered* view of the database: a
-- row it needs to compare against may be invisible to the writer, so the check either
-- passes when it should fail or fails when it should pass. Referential integrity is not a
-- per-caller question, so these read everything and answer the same way for everyone.
--
-- `set search_path = ''` plus fully-qualified names is what makes that safe: without it a
-- caller could point the function at a table of their own creation.
create or replace function app.assert_membership_role_same_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership_tenant uuid;
  v_role_tenant       uuid;
  v_branch_tenant     uuid;
begin
  select tenant_id into v_membership_tenant from public.tenant_memberships where id = new.membership_id;
  select tenant_id into v_role_tenant from public.roles where id = new.role_id;

  if v_membership_tenant is distinct from v_role_tenant then
    raise exception 'CROSS_TENANT_REFERENCE'
      using detail = 'The role and the membership belong to different tenants.';
  end if;

  if new.branch_id is not null then
    select tenant_id into v_branch_tenant from public.branches where id = new.branch_id;
    if v_branch_tenant is distinct from v_membership_tenant then
      raise exception 'CROSS_TENANT_REFERENCE'
        using detail = 'The branch and the membership belong to different tenants.';
    end if;
  end if;

  return new;
end;
$$;

create trigger membership_roles_same_tenant
  before insert or update on membership_roles
  for each row execute function app.assert_membership_role_same_tenant();

-- The same hazard applies to branch assignment.
create or replace function app.assert_membership_branch_same_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership_tenant uuid;
  v_branch_tenant     uuid;
begin
  select tenant_id into v_membership_tenant from public.tenant_memberships where id = new.membership_id;
  select tenant_id into v_branch_tenant from public.branches where id = new.branch_id;

  if v_membership_tenant is distinct from v_branch_tenant then
    raise exception 'CROSS_TENANT_REFERENCE'
      using detail = 'The branch and the membership belong to different tenants.';
  end if;

  return new;
end;
$$;

create trigger membership_branches_same_tenant
  before insert or update on membership_branches
  for each row execute function app.assert_membership_branch_same_tenant();
