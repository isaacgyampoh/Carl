-- =============================================================================
-- 0012 · Row Level Security — identity, tenancy, access control and devices
--
-- ## The rule
--
-- Every policy resolves through the authenticated identity and the database's own
-- membership records. No policy consults a value the client supplied. A caller who edits
-- `tenant_id` in a request body changes nothing, because nothing reads it.
--
-- ## FORCE ROW LEVEL SECURITY
--
-- `ENABLE` alone exempts the table's owner. Migrations run as the owner, and so does any
-- future SECURITY DEFINER function that forgets to scope itself. `FORCE` closes that.
-- The service role still bypasses RLS — that is its purpose, and why it never leaves the
-- server.
--
-- ## Reads and writes are separated deliberately
--
-- Read policies use app.can_read_tenant(). Write policies use app.can_write_tenant(),
-- which additionally requires the tenant to be in good standing. A suspended business can
-- still see its own records — withholding them is hostile, and for tax records legally
-- fraught — but cannot trade.
--
-- ## Why `(select app.…)`
--
-- Wrapping a helper in a scalar subquery lets PostgreSQL hoist it into an InitPlan
-- evaluated once per statement rather than once per row. On a large sales scan that is
-- the difference between a responsive POS and an unusable one.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- profiles
-- -----------------------------------------------------------------------------

alter table profiles enable row level security;
alter table profiles force row level security;

-- A user always sees their own profile.
create policy profiles_select_self on profiles
  for select to authenticated
  using (id = (select app.current_user_id()));

-- Colleagues are visible to each other, because a sales report naming only user IDs is
-- useless. Limited to people who share an active tenant.
create policy profiles_select_colleagues on profiles
  for select to authenticated
  using (
    exists (
      select 1
      from tenant_memberships mine
      join tenant_memberships theirs on theirs.tenant_id = mine.tenant_id
      where mine.user_id = (select app.current_user_id())
        and mine.status = 'ACTIVE'
        and theirs.user_id = profiles.id
        and theirs.status = 'ACTIVE'
    )
  );

create policy profiles_select_platform_admin on profiles
  for select to authenticated
  using ((select app.is_platform_admin()));

-- A user may edit their own profile. There is no privilege column on it to protect,
-- which is exactly why platform administration lives in its own table.
create policy profiles_update_self on profiles
  for update to authenticated
  using (id = (select app.current_user_id()))
  with check (id = (select app.current_user_id()));

-- Profiles are created by the provisioning flow (service role) or by a trigger on signup.
-- No INSERT or DELETE policy exists for `authenticated`, so both are refused.

-- -----------------------------------------------------------------------------
-- platform_admins
--
-- The one policy here must NOT call app.is_platform_admin(), which reads this table:
-- that would be the recursion this design exists to avoid. A user may see their own row
-- and nothing else, which is all the helper function needs to answer correctly.
--
-- There is no INSERT, UPDATE or DELETE policy. Platform administration is granted by an
-- audited server-side operation running as the service role, never by a client.
-- -----------------------------------------------------------------------------

alter table platform_admins enable row level security;
alter table platform_admins force row level security;

create policy platform_admins_select_self on platform_admins
  for select to authenticated
  using (user_id = (select app.current_user_id()));

-- -----------------------------------------------------------------------------
-- tenants
-- -----------------------------------------------------------------------------

alter table tenants enable row level security;
alter table tenants force row level security;

create policy tenants_select_member on tenants
  for select to authenticated
  using ((select app.can_read_tenant(tenants.id)));

create policy tenants_select_platform_admin on tenants
  for select to authenticated
  using ((select app.is_platform_admin()));

-- Only the owner or someone with settings.manage may change the business record, and
-- never while suspended.
create policy tenants_update_admin on tenants
  for update to authenticated
  using (
    (select app.can_write_tenant(tenants.id))
    and ((select app.is_tenant_owner(tenants.id)) or (select app.has_permission(tenants.id, 'settings.manage')))
  )
  with check (
    (select app.can_write_tenant(tenants.id))
    and ((select app.is_tenant_owner(tenants.id)) or (select app.has_permission(tenants.id, 'settings.manage')))
  );

-- Tenants are created and their status changed only by platform operations running as
-- the service role. A tenant cannot un-suspend itself.

-- -----------------------------------------------------------------------------
-- branches
-- -----------------------------------------------------------------------------

alter table branches enable row level security;
alter table branches force row level security;

-- Members see the branches they may act in. Someone assigned only to Kumasi does not see
-- that Accra exists.
create policy branches_select_member on branches
  for select to authenticated
  using (
    (select app.can_read_tenant(branches.tenant_id))
    and ((select app.can_access_branch(branches.id)) or (select app.has_permission(branches.tenant_id, 'branches.manage')))
  );

create policy branches_insert_manager on branches
  for insert to authenticated
  with check (
    (select app.can_write_tenant(branches.tenant_id))
    and (select app.has_permission(branches.tenant_id, 'branches.manage'))
  );

create policy branches_update_manager on branches
  for update to authenticated
  using (
    (select app.can_write_tenant(branches.tenant_id))
    and (select app.has_permission(branches.tenant_id, 'branches.manage'))
  )
  with check (
    (select app.can_write_tenant(branches.tenant_id))
    and (select app.has_permission(branches.tenant_id, 'branches.manage'))
  );

-- Branches are never deleted through the API. A branch with sales history cannot be
-- removed without destroying that history, so it is deactivated instead.

-- -----------------------------------------------------------------------------
-- tenant_memberships
-- -----------------------------------------------------------------------------

alter table tenant_memberships enable row level security;
alter table tenant_memberships force row level security;

create policy memberships_select_own on tenant_memberships
  for select to authenticated
  using (user_id = (select app.current_user_id()));

create policy memberships_select_staff_manager on tenant_memberships
  for select to authenticated
  using (
    (select app.can_read(tenant_memberships.tenant_id, 'staff.view'))
  );

create policy memberships_insert_manager on tenant_memberships
  for insert to authenticated
  with check (
    (select app.can_write_tenant(tenant_memberships.tenant_id))
    and (select app.has_permission(tenant_memberships.tenant_id, 'staff.manage'))
    -- Ownership is transferred by a dedicated, audited operation, never by inserting a
    -- membership that claims it.
    and is_owner = false
  );

create policy memberships_update_manager on tenant_memberships
  for update to authenticated
  using (
    (select app.can_write_tenant(tenant_memberships.tenant_id))
    and (select app.has_permission(tenant_memberships.tenant_id, 'staff.manage'))
  )
  with check (
    (select app.can_write_tenant(tenant_memberships.tenant_id))
    and (select app.has_permission(tenant_memberships.tenant_id, 'staff.manage'))
    and is_owner = false
  );

-- -----------------------------------------------------------------------------
-- membership_branches
-- -----------------------------------------------------------------------------

alter table membership_branches enable row level security;
alter table membership_branches force row level security;

create policy membership_branches_select on membership_branches
  for select to authenticated
  using (
    exists (
      select 1 from tenant_memberships m
      where m.id = membership_branches.membership_id
        and (
          m.user_id = (select app.current_user_id())
          or (select app.has_permission(m.tenant_id, 'staff.view'))
        )
    )
  );

create policy membership_branches_write on membership_branches
  for all to authenticated
  using (
    exists (
      select 1 from tenant_memberships m
      where m.id = membership_branches.membership_id
        and (select app.can_write_tenant(m.tenant_id))
        and (select app.has_permission(m.tenant_id, 'staff.manage'))
    )
  )
  with check (
    exists (
      select 1 from tenant_memberships m
      where m.id = membership_branches.membership_id
        and (select app.can_write_tenant(m.tenant_id))
        and (select app.has_permission(m.tenant_id, 'staff.manage'))
    )
  );

-- -----------------------------------------------------------------------------
-- permissions (global catalogue)
-- -----------------------------------------------------------------------------

alter table permissions enable row level security;
alter table permissions force row level security;

-- Readable by any signed-in user: the role editor needs the list, and the set of things
-- Carl can authorise is not confidential. Writable only by migration.
create policy permissions_select_all on permissions
  for select to authenticated
  using (true);

-- -----------------------------------------------------------------------------
-- roles and role_permissions
-- -----------------------------------------------------------------------------

alter table roles enable row level security;
alter table roles force row level security;

create policy roles_select_member on roles
  for select to authenticated
  using ((select app.can_read_tenant(roles.tenant_id)));

create policy roles_insert_manager on roles
  for insert to authenticated
  with check (
    (select app.can_write_tenant(roles.tenant_id))
    and (select app.has_permission(roles.tenant_id, 'roles.manage'))
    -- System roles are created by provisioning only.
    and is_system = false
  );

create policy roles_update_manager on roles
  for update to authenticated
  using (
    (select app.can_write_tenant(roles.tenant_id))
    and (select app.has_permission(roles.tenant_id, 'roles.manage'))
  )
  with check (
    (select app.can_write_tenant(roles.tenant_id))
    and (select app.has_permission(roles.tenant_id, 'roles.manage'))
  );

create policy roles_delete_manager on roles
  for delete to authenticated
  using (
    (select app.can_write_tenant(roles.tenant_id))
    and (select app.has_permission(roles.tenant_id, 'roles.manage'))
    and is_system = false
  );

alter table role_permissions enable row level security;
alter table role_permissions force row level security;

create policy role_permissions_select on role_permissions
  for select to authenticated
  using (
    exists (
      select 1 from roles r
      where r.id = role_permissions.role_id
        and (select app.can_read_tenant(r.tenant_id))
    )
  );

create policy role_permissions_write on role_permissions
  for all to authenticated
  using (
    exists (
      select 1 from roles r
      where r.id = role_permissions.role_id
        and (select app.can_write_tenant(r.tenant_id))
        and (select app.has_permission(r.tenant_id, 'roles.manage'))
    )
  )
  with check (
    exists (
      select 1 from roles r
      where r.id = role_permissions.role_id
        and (select app.can_write_tenant(r.tenant_id))
        and (select app.has_permission(r.tenant_id, 'roles.manage'))
    )
  );

-- -----------------------------------------------------------------------------
-- membership_roles
--
-- The privilege-escalation surface. Two guards beyond the permission check:
--
--   * the role must belong to the same tenant (also enforced by trigger)
--   * the granter's own strongest role must rank at least as high as the role granted,
--     so a supervisor cannot promote themselves to administrator
-- -----------------------------------------------------------------------------

alter table membership_roles enable row level security;
alter table membership_roles force row level security;

create policy membership_roles_select on membership_roles
  for select to authenticated
  using (
    exists (
      select 1 from tenant_memberships m
      where m.id = membership_roles.membership_id
        and (
          m.user_id = (select app.current_user_id())
          or (select app.has_permission(m.tenant_id, 'staff.view'))
        )
    )
  );

create policy membership_roles_write on membership_roles
  for all to authenticated
  using (
    exists (
      select 1 from tenant_memberships m
      where m.id = membership_roles.membership_id
        and (select app.can_write_tenant(m.tenant_id))
        and (select app.has_permission(m.tenant_id, 'roles.manage'))
    )
  )
  with check (
    exists (
      select 1
      from tenant_memberships m
      join roles r on r.id = membership_roles.role_id
      where m.id = membership_roles.membership_id
        and r.tenant_id = m.tenant_id
        and (select app.can_write_tenant(m.tenant_id))
        and (select app.has_permission(m.tenant_id, 'roles.manage'))
        -- No granting a role stronger than your own. Expressed as a function call
        -- because a policy on membership_roles may not query membership_roles - the
        -- rewriter rejects that as infinite recursion before it runs.
        and r.rank >= (select app.strongest_role_rank(m.tenant_id))
    )
  );

-- -----------------------------------------------------------------------------
-- devices, activations and sessions
--
-- Device secrets and activation hashes live in these tables. Reads are restricted to
-- holders of devices.view; the hash columns are never selected by application code, and
-- Phase 3 adds a view exposing only the safe columns.
-- -----------------------------------------------------------------------------

alter table devices enable row level security;
alter table devices force row level security;

create policy devices_select on devices
  for select to authenticated
  using (
    (select app.can_read(devices.tenant_id, 'devices.view', devices.branch_id))
  );

create policy devices_select_platform_admin on devices
  for select to authenticated
  using ((select app.is_platform_admin()));

create policy devices_write_manager on devices
  for all to authenticated
  using (
    (select app.can_write_tenant(devices.tenant_id))
    and (select app.has_permission(devices.tenant_id, 'devices.manage', devices.branch_id))
  )
  with check (
    (select app.can_write_tenant(devices.tenant_id))
    and (select app.has_permission(devices.tenant_id, 'devices.manage', devices.branch_id))
  );

alter table device_activations enable row level security;
alter table device_activations force row level security;

-- Activation codes are issued and redeemed by server-side operations running as the
-- service role. `authenticated` may see that a code exists (to show "code issued, expires
-- at…") but the hash is never returned by application queries.
create policy device_activations_select on device_activations
  for select to authenticated
  using (
    (select app.can_read(device_activations.tenant_id, 'devices.manage'))
  );

alter table device_sessions enable row level security;
alter table device_sessions force row level security;

create policy device_sessions_select on device_sessions
  for select to authenticated
  using (
    (select app.can_read(device_sessions.tenant_id, 'devices.manage'))
  );
