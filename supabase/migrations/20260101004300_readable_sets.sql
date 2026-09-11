-- Row Level Security that a query planner can work with.
--
-- Carl's read policies asked a question about every row: `app.can_read(sales.tenant_id,
-- 'sales.view_all', sales.branch_id)`. That is correct, and it is why a shop's second year
-- was going to be unusable. Measured on staging against a year of trade — 10,000 products,
-- 100,000 sales, 500,000 line items — as an authenticated cashier, with the plans in
-- docs/PERFORMANCE.md:
--
--   Sales list, first page                99 seconds   (budget 200 ms)
--   Product search by name                 6 seconds   (budget 200 ms)
--   Inventory ledger for one product       5.6 seconds (budget 300 ms)
--   Best sellers over a year               no answer within 60 seconds
--
-- Two properties of a function call in a policy cause this. PostgreSQL cannot drive an index
-- from it, because it is not a comparison against a constant; and because the function is not
-- LEAKPROOF, the security check must run BEFORE ordinary filters like `name ilike $1` or
-- `sold_at >= $1`. So every row is examined and the permission lookup runs for each one, with
-- the trigram index on products.name and the btree on sales (tenant_id, sold_at) sitting
-- unused beside it.
--
-- The fix is to ask the expensive question once per statement instead of once per row.
-- `app.readable_tenant_ids('sales.view')` and `app.readable_branch_ids('sales.view')` return
-- what the caller may read; the policies then compare a column to that set. A uuid `=` is
-- leakproof, so the planner is free to use any index it likes and to apply the user's own
-- filters first.
--
-- ## Why this does not change who can read what
--
-- Each set is built by calling the very same `app.can_read` over a candidate list, rather than
-- by restating the rule in a second place that could drift from it:
--
--   readable_tenant_ids(p)  = { t : app.can_read(t, p) },     candidates: the caller's active
--                                                              memberships and support grants
--   readable_branch_ids(p)  = { b : app.can_read(b.tenant_id, p, b.id) }
--
-- The candidate list is safe to narrow because `app.can_read` is false for a tenant the caller
-- is neither a member of nor holds a support grant on, and because a branch-scoped permission
-- grant also satisfies `app.has_permission(tenant, permission, null)` — the tenant-level form
-- counts any grant. So nothing that could have been readable is outside the candidates.
--
-- For a row, `tenant_id = any(readable_tenant_ids(p)) and branch_id = any(readable_branch_ids(p))`
-- holds exactly when `app.can_read(tenant_id, p, branch_id)` holds — provided the row's branch
-- belongs to the row's tenant, which until now nothing enforced. That is the first thing this
-- migration does.

-- ---------------------------------------------------------------------------------------
-- 1. A row's branch belongs to a row's tenant. Enforced, not assumed.
-- ---------------------------------------------------------------------------------------

-- `id` is already unique on its own; this pair is what a composite foreign key can reference.
alter table public.branches
  add constraint branches_tenant_id_id_key unique (tenant_id, id);

alter table public.sales
  add constraint sales_branch_in_tenant_fkey
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id)
  on delete restrict;

alter table public.sale_items
  add constraint sale_items_branch_in_tenant_fkey
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id)
  on delete cascade;

alter table public.inventory_movements
  add constraint inventory_movements_branch_in_tenant_fkey
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id)
  on delete cascade;

-- ---------------------------------------------------------------------------------------
-- 2. The sets, resolved once per statement.
-- ---------------------------------------------------------------------------------------

create or replace function app.readable_tenant_ids(p_permission text)
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
     where m.user_id = auth.uid()
       and m.status = 'ACTIVE'
    union
    select g.tenant_id
      from public.tenant_support_grants g
     where g.grantee_id = auth.uid()
       and g.revoked_at is null
       and g.expires_at > now()
  ) c
  where app.can_read(c.tenant_id, p_permission)
$$;

comment on function app.readable_tenant_ids(text) is
  'The businesses the caller may read under one permission. Decided by app.can_read, so it '
  'cannot drift from the rule the rest of the schema enforces.';

create or replace function app.readable_branch_ids(p_permission text)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(b.id), array[]::uuid[])
  from public.branches b
  where b.tenant_id = any (app.readable_tenant_ids(p_permission))
    and app.can_read(b.tenant_id, p_permission, b.id)
$$;

comment on function app.readable_branch_ids(text) is
  'The branches the caller may read under one permission. A shop has a handful, so this is '
  'cheap to resolve once and compare against per row.';

revoke all on function app.readable_tenant_ids(text) from public;
revoke all on function app.readable_branch_ids(text) from public;
grant execute on function app.readable_tenant_ids(text) to authenticated, service_role;
grant execute on function app.readable_branch_ids(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- 3. The read policies, restated against those sets.
--
-- `= any (coalesce((select ...), array[]::uuid[]))` rather than the shorter `= any (select
-- ...)`: PostgreSQL reads a parenthesised SELECT in that position as a set of ROWS, and the
-- shorter form is a type error — uuid = uuid[]. Wrapping it in coalesce makes it an ordinary
-- array expression containing a sub-SELECT, which is planned as an InitPlan: resolved once
-- for the statement and substituted as a parameter, so every row sees a plain `= any($0)`.
-- The function never returns null, so the coalesce only ever settles the grammar.
-- ---------------------------------------------------------------------------------------

drop policy if exists products_select on public.products;
create policy products_select on public.products
  for select to authenticated
  using (tenant_id = any (coalesce((select app.readable_tenant_ids('products.view')), array[]::uuid[])));

-- Two permissive policies used to be ORed together by PostgreSQL, which removed the last
-- chance of an index-driven plan. One policy, the same rule.
drop policy if exists sales_select_all on public.sales;
drop policy if exists sales_select_own on public.sales;
create policy sales_select on public.sales
  for select to authenticated
  using (
    (
      tenant_id = any (coalesce((select app.readable_tenant_ids('sales.view_all')), array[]::uuid[]))
      and branch_id = any (coalesce((select app.readable_branch_ids('sales.view_all')), array[]::uuid[]))
    )
    or (
      tenant_id = any (coalesce((select app.readable_tenant_ids('sales.view')), array[]::uuid[]))
      and branch_id = any (coalesce((select app.readable_branch_ids('sales.view')), array[]::uuid[]))
      and cashier_id = (select app.current_user_id())
    )
  );

-- A line belongs to whoever may read its sale. Asked of the parent row, by primary key,
-- exactly as before — only the checks inside it are now set comparisons.
drop policy if exists sale_items_select on public.sale_items;
create policy sale_items_select on public.sale_items
  for select to authenticated
  using (
    exists (
      select 1
        from public.sales s
       where s.id = sale_items.sale_id
         and (
           (
             s.tenant_id = any (coalesce((select app.readable_tenant_ids('sales.view_all')), array[]::uuid[]))
             and s.branch_id = any (coalesce((select app.readable_branch_ids('sales.view_all')), array[]::uuid[]))
           )
           or (
             s.tenant_id = any (coalesce((select app.readable_tenant_ids('sales.view')), array[]::uuid[]))
             and s.branch_id = any (coalesce((select app.readable_branch_ids('sales.view')), array[]::uuid[]))
             and s.cashier_id = (select app.current_user_id())
           )
         )
    )
  );

drop policy if exists inventory_movements_select on public.inventory_movements;
create policy inventory_movements_select on public.inventory_movements
  for select to authenticated
  using (
    tenant_id = any (coalesce((select app.readable_tenant_ids('inventory.view')), array[]::uuid[]))
    and branch_id = any (coalesce((select app.readable_branch_ids('inventory.view')), array[]::uuid[]))
  );
