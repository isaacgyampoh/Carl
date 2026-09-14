-- The rest of the read policies, resolved once per statement.
--
-- 20260101004300 did this for `sales`, `sale_items`, `products` and `inventory_movements`.
-- Thirty-three policies were left asking `app.can_read` about every row, and the argument
-- that justified the first four applies to all of them: every paged screen in Carl asks
-- PostgREST for `count: 'exact'`, which counts the whole filtered set, so a per-row
-- permission lookup runs once for every row a business has ever recorded.
--
-- Measured on the same laptop, old policy against new (docs/PERFORMANCE.md carries the table):
-- the exact count beside a list of 20,000 sales was 2,016 ms and is 10.8 ms.
--
-- ## The four sets
--
-- Each is built by calling the very function it replaces, over the caller's own memberships
-- and support grants, so none of them can drift from the rule the schema enforces:
--
--   member_tenant_ids()          { t : app.can_read_tenant(t) }
--   permitted_tenant_ids(p)      { t : app.has_permission(t, p) }
--   accessible_branch_ids_all()  { b : app.can_read_tenant(b.tenant) and app.can_access_branch(b) }
--   permitted_branch_ids(p)      { b : app.has_permission(b.tenant, p, b) }
--
-- alongside the two from the previous migration, readable_tenant_ids(p) and
-- readable_branch_ids(p). A shop has a handful of branches and a person belongs to one or two
-- businesses, so every one of these is cheap to resolve once and compare against per row.
--
-- ## Why the foreign keys come first
--
-- `tenant_id = any(T) and branch_id = any(B)` is equivalent to `can_read(tenant_id, p,
-- branch_id)` only while a row's branch belongs to a row's tenant. Nothing enforced that on
-- these tables. Now something does — and every table below was checked for violations before
-- the key was added.

-- ---------------------------------------------------------------------------------------
-- 1. A row's branch belongs to a row's tenant.
-- ---------------------------------------------------------------------------------------

alter table public.devices
  add constraint devices_branch_in_tenant_fkey
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id) on delete cascade;

alter table public.expenses
  add constraint expenses_branch_in_tenant_fkey
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id) on delete cascade;

alter table public.inventory
  add constraint inventory_branch_in_tenant_fkey
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id) on delete cascade;

alter table public.purchases
  add constraint purchases_branch_in_tenant_fkey
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id) on delete cascade;

alter table public.purchase_payments
  add constraint purchase_payments_branch_in_tenant_fkey
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id) on delete cascade;

alter table public.sale_returns
  add constraint sale_returns_branch_in_tenant_fkey
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id) on delete cascade;

alter table public.stock_counts
  add constraint stock_counts_branch_in_tenant_fkey
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id) on delete cascade;

alter table public.cash_sessions
  add constraint cash_sessions_branch_in_tenant_fkey
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id) on delete cascade;

alter table public.cash_registers
  add constraint cash_registers_branch_in_tenant_fkey
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id) on delete cascade;

alter table public.stock_transfers
  add constraint stock_transfers_from_branch_in_tenant_fkey
  foreign key (tenant_id, from_branch_id) references public.branches (tenant_id, id)
  on delete cascade;

alter table public.stock_transfers
  add constraint stock_transfers_to_branch_in_tenant_fkey
  foreign key (tenant_id, to_branch_id) references public.branches (tenant_id, id)
  on delete cascade;

-- ---------------------------------------------------------------------------------------
-- 2. The sets.
-- ---------------------------------------------------------------------------------------

create or replace function app.member_tenant_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(c.tenant_id), array[]::uuid[])
  from (
    select m.tenant_id
      from public.tenant_memberships m
     where m.user_id = auth.uid() and m.status = 'ACTIVE'
    union
    select g.tenant_id
      from public.tenant_support_grants g
     where g.grantee_id = auth.uid() and g.revoked_at is null and g.expires_at > now()
  ) c
  where app.can_read_tenant(c.tenant_id)
$$;

comment on function app.member_tenant_ids() is
  'The businesses the caller belongs to or holds a support grant on. Decided by '
  'app.can_read_tenant, so it cannot drift from it.';

create or replace function app.permitted_tenant_ids(p_permission text)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(c.tenant_id), array[]::uuid[])
  from (
    select m.tenant_id
      from public.tenant_memberships m
     where m.user_id = auth.uid() and m.status = 'ACTIVE'
  ) c
  where app.has_permission(c.tenant_id, p_permission)
$$;

comment on function app.permitted_tenant_ids(text) is
  'The businesses where the caller holds one permission through a role. A support grant is '
  'deliberately not a permission, which is what app.has_permission already says.';

create or replace function app.accessible_branch_ids_all()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(b.id), array[]::uuid[])
  from public.branches b
  where b.tenant_id = any (app.member_tenant_ids())
    and app.can_access_branch(b.id)
$$;

comment on function app.accessible_branch_ids_all() is
  'The branches the caller may act in, for the tables whose rule is membership plus branch '
  'access rather than a named permission.';

create or replace function app.permitted_branch_ids(p_permission text)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(b.id), array[]::uuid[])
  from public.branches b
  where b.tenant_id = any (app.member_tenant_ids())
    and app.has_permission(b.tenant_id, p_permission, b.id)
$$;

comment on function app.permitted_branch_ids(text) is
  'The branches where the caller holds one permission, whether granted tenant-wide or for '
  'that branch.';

revoke all on function app.member_tenant_ids() from public;
revoke all on function app.permitted_tenant_ids(text) from public;
revoke all on function app.accessible_branch_ids_all() from public;
revoke all on function app.permitted_branch_ids(text) from public;
grant execute on function app.member_tenant_ids() to authenticated, service_role;
grant execute on function app.permitted_tenant_ids(text) to authenticated, service_role;
grant execute on function app.accessible_branch_ids_all() to authenticated, service_role;
grant execute on function app.permitted_branch_ids(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- 3. The policies, restated against those sets.
--
-- `= any (coalesce((select ...), array[]::uuid[]))` throughout: a parenthesised SELECT in
-- that position is read as a set of ROWS and is a type error, and wrapping it in coalesce
-- makes it an array expression containing a sub-SELECT — planned as an InitPlan, resolved
-- once for the statement, substituted as a parameter. The functions never return null, so
-- the coalesce only settles the grammar.
-- ---------------------------------------------------------------------------------------

-- Businesses, and the caller's own membership of them ------------------------------------

drop policy if exists tenants_select_member on public.tenants;
create policy tenants_select_member on public.tenants
  for select to authenticated
  using (id = any (coalesce((select app.member_tenant_ids()), array[]::uuid[])));

drop policy if exists memberships_select_staff_manager on public.tenant_memberships;
create policy memberships_select_staff_manager on public.tenant_memberships
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.readable_tenant_ids('staff.view')), array[]::uuid[]))
  );

drop policy if exists roles_select_member on public.roles;
create policy roles_select_member on public.roles
  for select to authenticated
  using (tenant_id = any (coalesce((select app.member_tenant_ids()), array[]::uuid[])));

drop policy if exists role_permissions_select on public.role_permissions;
create policy role_permissions_select on public.role_permissions
  for select to authenticated
  using (
    exists (
      select 1 from public.roles r
       where r.id = role_permissions.role_id
         and r.tenant_id = any (coalesce((select app.member_tenant_ids()), array[]::uuid[]))
    )
  );

-- A branch is readable to somebody who works in it, or to whoever manages branches.
drop policy if exists branches_select_member on public.branches;
create policy branches_select_member on public.branches
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.member_tenant_ids()), array[]::uuid[]))
    and (
      id = any (coalesce((select app.accessible_branch_ids_all()), array[]::uuid[]))
      or tenant_id = any (
        coalesce((select app.permitted_tenant_ids('branches.manage')), array[]::uuid[])
      )
    )
  );

-- The catalogue --------------------------------------------------------------------------

drop policy if exists categories_select on public.categories;
create policy categories_select on public.categories
  for select to authenticated
  using (tenant_id = any (coalesce((select app.member_tenant_ids()), array[]::uuid[])));

drop policy if exists product_prices_select on public.product_prices;
create policy product_prices_select on public.product_prices
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.readable_tenant_ids('products.view')), array[]::uuid[]))
  );

drop policy if exists product_barcodes_select on public.product_barcodes;
create policy product_barcodes_select on public.product_barcodes
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.readable_tenant_ids('products.view')), array[]::uuid[]))
  );

drop policy if exists inventory_select on public.inventory;
create policy inventory_select on public.inventory
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.readable_tenant_ids('inventory.view')), array[]::uuid[]))
    and branch_id = any (
      coalesce((select app.readable_branch_ids('inventory.view')), array[]::uuid[])
    )
  );

drop policy if exists stock_counts_select on public.stock_counts;
create policy stock_counts_select on public.stock_counts
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.readable_tenant_ids('inventory.view')), array[]::uuid[]))
    and branch_id = any (
      coalesce((select app.readable_branch_ids('inventory.view')), array[]::uuid[])
    )
  );

drop policy if exists stock_count_items_select on public.stock_count_items;
create policy stock_count_items_select on public.stock_count_items
  for select to authenticated
  using (
    exists (
      select 1 from public.stock_counts c
       where c.id = stock_count_items.stock_count_id
         and c.tenant_id = any (coalesce((select app.member_tenant_ids()), array[]::uuid[]))
         and c.branch_id = any (
           coalesce((select app.accessible_branch_ids_all()), array[]::uuid[])
         )
    )
  );

-- Stock moving between branches: readable from either end.
drop policy if exists stock_transfers_select on public.stock_transfers;
create policy stock_transfers_select on public.stock_transfers
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.member_tenant_ids()), array[]::uuid[]))
    and (
      from_branch_id = any (coalesce((select app.accessible_branch_ids_all()), array[]::uuid[]))
      or to_branch_id = any (coalesce((select app.accessible_branch_ids_all()), array[]::uuid[]))
    )
    and tenant_id = any (
      coalesce((select app.permitted_tenant_ids('inventory.view')), array[]::uuid[])
    )
  );

drop policy if exists stock_transfer_items_select on public.stock_transfer_items;
create policy stock_transfer_items_select on public.stock_transfer_items
  for select to authenticated
  using (
    exists (
      select 1 from public.stock_transfers t
       where t.id = stock_transfer_items.transfer_id
         and t.tenant_id = any (coalesce((select app.member_tenant_ids()), array[]::uuid[]))
         and (
           t.from_branch_id = any (
             coalesce((select app.accessible_branch_ids_all()), array[]::uuid[])
           )
           or t.to_branch_id = any (
             coalesce((select app.accessible_branch_ids_all()), array[]::uuid[])
           )
         )
    )
  );

drop policy if exists sync_conflicts_select on public.sync_conflicts;
create policy sync_conflicts_select on public.sync_conflicts
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.readable_tenant_ids('inventory.view')), array[]::uuid[]))
  );

-- People a shop sells to, and people it buys from ----------------------------------------

drop policy if exists customers_select on public.customers;
create policy customers_select on public.customers
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.readable_tenant_ids('customers.view')), array[]::uuid[]))
  );

drop policy if exists suppliers_select on public.suppliers;
create policy suppliers_select on public.suppliers
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.readable_tenant_ids('suppliers.view')), array[]::uuid[]))
  );

-- Money out: purchases and expenses -------------------------------------------------------

drop policy if exists purchases_select on public.purchases;
create policy purchases_select on public.purchases
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.readable_tenant_ids('purchases.view')), array[]::uuid[]))
    and branch_id = any (
      coalesce((select app.readable_branch_ids('purchases.view')), array[]::uuid[])
    )
  );

drop policy if exists purchase_items_select on public.purchase_items;
create policy purchase_items_select on public.purchase_items
  for select to authenticated
  using (
    exists (
      select 1 from public.purchases p
       where p.id = purchase_items.purchase_id
         and p.tenant_id = any (
           coalesce((select app.readable_tenant_ids('purchases.view')), array[]::uuid[])
         )
         and p.branch_id = any (
           coalesce((select app.readable_branch_ids('purchases.view')), array[]::uuid[])
         )
    )
  );

drop policy if exists purchase_payments_select on public.purchase_payments;
create policy purchase_payments_select on public.purchase_payments
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.readable_tenant_ids('purchases.view')), array[]::uuid[]))
    and branch_id = any (
      coalesce((select app.readable_branch_ids('purchases.view')), array[]::uuid[])
    )
  );

drop policy if exists expenses_select on public.expenses;
create policy expenses_select on public.expenses
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.readable_tenant_ids('expenses.view')), array[]::uuid[]))
    and branch_id = any (
      coalesce((select app.readable_branch_ids('expenses.view')), array[]::uuid[])
    )
  );

drop policy if exists expense_categories_select on public.expense_categories;
create policy expense_categories_select on public.expense_categories
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.readable_tenant_ids('expenses.view')), array[]::uuid[]))
  );

-- Money back out of the till: returns and payments -----------------------------------------

drop policy if exists sale_returns_select on public.sale_returns;
create policy sale_returns_select on public.sale_returns
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.readable_tenant_ids('sales.view')), array[]::uuid[]))
    and branch_id = any (coalesce((select app.readable_branch_ids('sales.view')), array[]::uuid[]))
  );

drop policy if exists sale_return_items_select on public.sale_return_items;
create policy sale_return_items_select on public.sale_return_items
  for select to authenticated
  using (
    exists (
      select 1 from public.sale_returns r
       where r.id = sale_return_items.return_id
         and r.tenant_id = any (coalesce((select app.member_tenant_ids()), array[]::uuid[]))
         and r.branch_id = any (
           coalesce((select app.accessible_branch_ids_all()), array[]::uuid[])
         )
    )
  );

-- A payment belongs to whoever may read its sale, exactly as before.
drop policy if exists sale_payments_select on public.sale_payments;
create policy sale_payments_select on public.sale_payments
  for select to authenticated
  using (
    exists (
      select 1 from public.sales s
       where s.id = sale_payments.sale_id
         and s.tenant_id = any (coalesce((select app.member_tenant_ids()), array[]::uuid[]))
         and s.branch_id = any (coalesce((select app.accessible_branch_ids_all()), array[]::uuid[]))
         and (
           s.branch_id = any (
             coalesce((select app.permitted_branch_ids('sales.view_all')), array[]::uuid[])
           )
           or (
             s.branch_id = any (
               coalesce((select app.permitted_branch_ids('sales.view')), array[]::uuid[])
             )
             and s.cashier_id = (select app.current_user_id())
           )
         )
    )
  );

-- The till drawer ---------------------------------------------------------------------------

drop policy if exists cash_registers_select on public.cash_registers;
create policy cash_registers_select on public.cash_registers
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.member_tenant_ids()), array[]::uuid[]))
    and branch_id = any (coalesce((select app.accessible_branch_ids_all()), array[]::uuid[]))
  );

drop policy if exists cash_sessions_select_own on public.cash_sessions;
create policy cash_sessions_select_own on public.cash_sessions
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.member_tenant_ids()), array[]::uuid[]))
    and branch_id = any (coalesce((select app.accessible_branch_ids_all()), array[]::uuid[]))
    and opened_by = (select app.current_user_id())
  );

drop policy if exists cash_sessions_select_supervisor on public.cash_sessions;
create policy cash_sessions_select_supervisor on public.cash_sessions
  for select to authenticated
  using (
    tenant_id = any (
      coalesce((select app.readable_tenant_ids('register.view_variance')), array[]::uuid[])
    )
    and branch_id = any (
      coalesce((select app.readable_branch_ids('register.view_variance')), array[]::uuid[])
    )
  );

drop policy if exists cash_movements_select on public.cash_movements;
create policy cash_movements_select on public.cash_movements
  for select to authenticated
  using (
    exists (
      select 1 from public.cash_sessions s
       where s.id = cash_movements.session_id
         and s.tenant_id = any (coalesce((select app.member_tenant_ids()), array[]::uuid[]))
         and s.branch_id = any (coalesce((select app.accessible_branch_ids_all()), array[]::uuid[]))
         and (
           s.opened_by = (select app.current_user_id())
           or s.branch_id = any (
             coalesce((select app.permitted_branch_ids('register.view_variance')), array[]::uuid[])
           )
         )
    )
  );

-- Terminals ----------------------------------------------------------------------------------

drop policy if exists devices_select on public.devices;
create policy devices_select on public.devices
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.readable_tenant_ids('devices.view')), array[]::uuid[]))
    and branch_id = any (coalesce((select app.readable_branch_ids('devices.view')), array[]::uuid[]))
  );

drop policy if exists device_activations_select on public.device_activations;
create policy device_activations_select on public.device_activations
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.readable_tenant_ids('devices.manage')), array[]::uuid[]))
  );

drop policy if exists device_sessions_select on public.device_sessions;
create policy device_sessions_select on public.device_sessions
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.readable_tenant_ids('devices.manage')), array[]::uuid[]))
  );

-- What happened, and who was told ---------------------------------------------------------------

drop policy if exists audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (
    tenant_id is not null
    and tenant_id = any (coalesce((select app.readable_tenant_ids('audit.view')), array[]::uuid[]))
  );

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.member_tenant_ids()), array[]::uuid[]))
    and (user_id = (select app.current_user_id()) or user_id is null)
  );
