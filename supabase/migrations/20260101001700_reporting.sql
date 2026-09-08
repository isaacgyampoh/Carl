-- =============================================================================
-- 0017 · Reporting
--
-- ## Why reports are SQL functions
--
-- A dashboard figure like "today's takings" is one number derived from every sale in a
-- day. Computing it in React means shipping every one of those rows to a phone over a
-- Ghanaian mobile connection and summing them there — slow, expensive, and increasingly
-- impossible as the shop succeeds.
--
-- These functions aggregate in the database and return the handful of numbers actually
-- displayed.
--
-- ## They are SECURITY INVOKER on purpose
--
-- Unlike the transactional functions, these run as the *caller*, so every underlying
-- SELECT passes through Row Level Security exactly as a direct query would. A report
-- therefore cannot become a hole through which one tenant reads another's figures, and no
-- separate authorization logic has to be written or kept in step.
--
-- ## sold_at, not created_at
--
-- Every date filter uses `sold_at`. For a sale made offline, `created_at` is when the row
-- reached the server — hours or days later. Reporting on that would put a Saturday's
-- takings into Monday.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- tenant_dashboard_today
--
-- A NULL branch means "every branch I can reach", which RLS resolves without this function
-- needing to know which those are.
-- -----------------------------------------------------------------------------

create or replace function tenant_dashboard_today(
  p_tenant_id uuid,
  p_branch_id uuid default null
)
returns table (
  sales_count bigint,
  gross       bigint,
  cost        bigint,
  cash        bigint,
  momo        bigint
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with todays_sales as (
    select s.id, s.total, s.cost_total
    from sales s
    where s.tenant_id = p_tenant_id
      and (p_branch_id is null or s.branch_id = p_branch_id)
      and s.status <> 'VOIDED'
      -- The tenant's own local day. Reporting a shop's takings in UTC would cut the day
      -- at an arbitrary hour and split an evening's trade across two dates.
      and s.sold_at >= date_trunc('day', now() at time zone coalesce(
        (select t.timezone from tenants t where t.id = p_tenant_id), 'UTC'
      ))
  ),
  payments as (
    select p.method, sum(p.amount) as amount
    from sale_payments p
    join todays_sales s on s.id = p.sale_id
    group by p.method
  )
  select
    (select count(*) from todays_sales),
    coalesce((select sum(total) from todays_sales), 0),
    coalesce((select sum(cost_total) from todays_sales), 0),
    coalesce((select amount from payments where method = 'CASH'), 0),
    coalesce((select amount from payments where method = 'MOMO'), 0)
$$;

comment on function tenant_dashboard_today(uuid, uuid) is
  'Today''s headline figures. SECURITY INVOKER, so RLS filters the underlying rows as usual.';

-- -----------------------------------------------------------------------------
-- sales_summary
--
-- The figures behind every date-ranged sales report.
-- -----------------------------------------------------------------------------

create or replace function sales_summary(
  p_tenant_id uuid,
  p_from      timestamptz,
  p_to        timestamptz,
  p_branch_id uuid default null
)
returns table (
  sales_count       bigint,
  gross             bigint,
  discounts         bigint,
  tax               bigint,
  cost              bigint,
  profit            bigint,
  refunds           bigint,
  average_sale      bigint,
  items_sold        numeric
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with scoped as (
    select s.id, s.total, s.discount_amount, s.tax_amount, s.cost_total, s.amount_refunded
    from sales s
    where s.tenant_id = p_tenant_id
      and (p_branch_id is null or s.branch_id = p_branch_id)
      and s.status <> 'VOIDED'
      and s.sold_at >= p_from
      and s.sold_at < p_to
  )
  select
    count(*),
    coalesce(sum(total), 0),
    coalesce(sum(discount_amount), 0),
    coalesce(sum(tax_amount), 0),
    coalesce(sum(cost_total), 0),
    coalesce(sum(total) - sum(cost_total), 0),
    coalesce(sum(amount_refunded), 0),
    -- Integer division, deliberately: an average in whole pesewas. Reporting a fraction of
    -- the smallest unit of currency is noise.
    case when count(*) = 0 then 0 else coalesce(sum(total), 0) / count(*) end,
    coalesce(
      (select sum(si.quantity) from sale_items si join scoped x on x.id = si.sale_id),
      0
    )
  from scoped
$$;

-- -----------------------------------------------------------------------------
-- top_products
-- -----------------------------------------------------------------------------

create or replace function top_products(
  p_tenant_id uuid,
  p_from      timestamptz,
  p_to        timestamptz,
  p_branch_id uuid default null,
  p_limit     integer default 10
)
returns table (
  product_id    uuid,
  product_name  text,
  quantity_sold numeric,
  revenue       bigint,
  profit        bigint
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select
    si.product_id,
    -- The name recorded at sale time, so a renamed or deleted product still reports.
    max(si.product_name),
    sum(si.quantity),
    sum(si.line_total),
    sum(si.line_total) - sum((si.unit_cost * si.quantity)::bigint)
  from sale_items si
  join sales s on s.id = si.sale_id
  where s.tenant_id = p_tenant_id
    and (p_branch_id is null or s.branch_id = p_branch_id)
    and s.status <> 'VOIDED'
    and s.sold_at >= p_from
    and s.sold_at < p_to
  group by si.product_id
  order by sum(si.line_total) desc
  limit least(greatest(p_limit, 1), 100)
$$;

comment on function top_products is
  'Best sellers by revenue. The limit is clamped so a caller cannot request an unbounded scan.';

-- -----------------------------------------------------------------------------
-- payment_method_breakdown
--
-- What the till should contain, split by tender. The first thing checked when a drawer
-- does not reconcile.
-- -----------------------------------------------------------------------------

create or replace function payment_method_breakdown(
  p_tenant_id uuid,
  p_from      timestamptz,
  p_to        timestamptz,
  p_branch_id uuid default null
)
returns table (
  method        payment_method,
  payment_count bigint,
  amount        bigint
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select p.method, count(*), sum(p.amount)
  from sale_payments p
  join sales s on s.id = p.sale_id
  where s.tenant_id = p_tenant_id
    and (p_branch_id is null or s.branch_id = p_branch_id)
    and s.status <> 'VOIDED'
    and s.sold_at >= p_from
    and s.sold_at < p_to
  group by p.method
  order by sum(p.amount) desc
$$;

-- -----------------------------------------------------------------------------
-- low_stock
-- -----------------------------------------------------------------------------

create or replace function low_stock(
  p_tenant_id uuid,
  p_branch_id uuid default null,
  p_limit     integer default 50
)
returns table (
  product_id    uuid,
  product_name  text,
  branch_id     uuid,
  quantity      numeric,
  reorder_level numeric,
  shortfall     numeric
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select
    i.product_id,
    p.name::text,
    i.branch_id,
    i.quantity,
    i.reorder_level,
    greatest(i.reorder_level - i.quantity, 0)
  from inventory i
  join products p on p.id = i.product_id
  where i.tenant_id = p_tenant_id
    and (p_branch_id is null or i.branch_id = p_branch_id)
    and p.is_active
    and p.is_stock_tracked
    and i.quantity <= i.reorder_level
  order by (i.reorder_level - i.quantity) desc, p.name
  limit least(greatest(p_limit, 1), 200)
$$;

-- -----------------------------------------------------------------------------
-- stock_valuation
--
-- What the stock on the shelves is worth, at cost. The figure an owner needs for accounts
-- and for insurance.
-- -----------------------------------------------------------------------------

create or replace function stock_valuation(
  p_tenant_id uuid,
  p_branch_id uuid default null
)
returns table (
  product_count bigint,
  total_units   numeric,
  cost_value    bigint,
  retail_value  bigint
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select
    count(distinct i.product_id),
    coalesce(sum(i.quantity), 0),
    coalesce(sum((i.quantity * p.average_cost)::bigint), 0),
    coalesce(
      sum((i.quantity * coalesce(
        (select pp.amount from product_prices pp
          where pp.product_id = p.id
            and pp.tier = 'RETAIL'
            and pp.effective_to is null
            and (pp.branch_id is null or pp.branch_id = i.branch_id)
          order by pp.branch_id nulls last, pp.min_quantity
          limit 1
        ), 0))::bigint),
      0
    )
  from inventory i
  join products p on p.id = i.product_id
  where i.tenant_id = p_tenant_id
    and (p_branch_id is null or i.branch_id = p_branch_id)
    and p.is_active
    and p.is_stock_tracked
    and i.quantity > 0
$$;

-- -----------------------------------------------------------------------------
-- staff_sales_summary
-- -----------------------------------------------------------------------------

create or replace function staff_sales_summary(
  p_tenant_id uuid,
  p_from      timestamptz,
  p_to        timestamptz,
  p_branch_id uuid default null
)
returns table (
  cashier_id    uuid,
  cashier_name  text,
  sales_count   bigint,
  gross         bigint,
  refunds       bigint
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select
    s.cashier_id,
    coalesce(pr.full_name::text, 'Unknown'),
    count(*),
    sum(s.total),
    sum(s.amount_refunded)
  from sales s
  left join profiles pr on pr.id = s.cashier_id
  where s.tenant_id = p_tenant_id
    and (p_branch_id is null or s.branch_id = p_branch_id)
    and s.status <> 'VOIDED'
    and s.sold_at >= p_from
    and s.sold_at < p_to
  group by s.cashier_id, pr.full_name
  order by sum(s.total) desc
$$;

-- -----------------------------------------------------------------------------
-- Grants
--
-- SECURITY INVOKER means these carry no privilege of their own; RLS still filters every
-- underlying row. They are granted to authenticated and withheld from anon.
-- -----------------------------------------------------------------------------

revoke execute on function tenant_dashboard_today(uuid, uuid) from public, anon;
revoke execute on function sales_summary(uuid, timestamptz, timestamptz, uuid) from public, anon;
revoke execute on function top_products(uuid, timestamptz, timestamptz, uuid, integer) from public, anon;
revoke execute on function payment_method_breakdown(uuid, timestamptz, timestamptz, uuid) from public, anon;
revoke execute on function low_stock(uuid, uuid, integer) from public, anon;
revoke execute on function stock_valuation(uuid, uuid) from public, anon;
revoke execute on function staff_sales_summary(uuid, timestamptz, timestamptz, uuid) from public, anon;

grant execute on function tenant_dashboard_today(uuid, uuid) to authenticated, service_role;
grant execute on function sales_summary(uuid, timestamptz, timestamptz, uuid) to authenticated, service_role;
grant execute on function top_products(uuid, timestamptz, timestamptz, uuid, integer) to authenticated, service_role;
grant execute on function payment_method_breakdown(uuid, timestamptz, timestamptz, uuid) to authenticated, service_role;
grant execute on function low_stock(uuid, uuid, integer) to authenticated, service_role;
grant execute on function stock_valuation(uuid, uuid) to authenticated, service_role;
grant execute on function staff_sales_summary(uuid, timestamptz, timestamptz, uuid) to authenticated, service_role;
