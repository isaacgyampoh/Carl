-- =============================================================================
-- Performance probe.
--
-- Generates realistic volume and reports query plans for the paths that matter, so index
-- usage is measured rather than assumed.
--
-- Everything is generated server-side with generate_series: creating a hundred thousand
-- sales one INSERT at a time over a network connection would take hours and measure the
-- network rather than the database.
--
-- DESTRUCTIVE. Only run against a disposable verification project.
-- =============================================================================

\timing on

-- --- Volume ------------------------------------------------------------------------------

do $$
declare
  v_tenant_id uuid;
  v_branch_id uuid;
  v_admin     uuid := '00000000-0000-4000-8000-0000000000ff';
begin
  insert into auth.users (id, email) values (v_admin, 'perf@carl.test')
  on conflict (id) do nothing;
  insert into public.profiles (id, email, full_name)
  values (v_admin, 'perf@carl.test', 'Performance Probe')
  on conflict (id) do nothing;
  insert into public.platform_admins (user_id) values (v_admin) on conflict do nothing;

  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_admin), true);

  select tenant_id, branch_id into v_tenant_id, v_branch_id
  from public.provision_tenant('perf-test', 'Performance Test Co', 'perf@carl.test',
                               'Performance Probe', v_admin, 'Main', 'main', 'ACTIVE', 14);

  -- 10,000 products with a retail price each.
  insert into public.products (tenant_id, name, sku, unit, average_cost, reorder_level, tax_mode, tax_rate)
  select v_tenant_id,
         'Product ' || g,
         'SKU-' || lpad(g::text, 6, '0'),
         'unit',
         (100 + (random() * 5000))::bigint,
         20,
         'INCLUSIVE',
         15
  from generate_series(1, 10000) g;

  insert into public.product_prices (tenant_id, product_id, tier, amount)
  select v_tenant_id, p.id, 'RETAIL', p.average_cost + 500
  from public.products p where p.tenant_id = v_tenant_id;

  insert into public.product_barcodes (tenant_id, product_id, barcode)
  select v_tenant_id, p.id, '50' || lpad(row_number() over (order by p.sku)::text, 11, '0')
  from public.products p where p.tenant_id = v_tenant_id;

  insert into public.inventory (tenant_id, branch_id, product_id, quantity, reorder_level)
  select v_tenant_id, v_branch_id, p.id, 100, 20
  from public.products p where p.tenant_id = v_tenant_id;

  -- 100,000 sales spread over a year.
  insert into public.sales
    (tenant_id, branch_id, sale_number, cashier_id, subtotal, total, cost_total,
     amount_paid, sold_at, status)
  select v_tenant_id, v_branch_id,
         'PERF-' || lpad(g::text, 8, '0'),
         v_admin,
         (500 + random() * 20000)::bigint,
         (500 + random() * 20000)::bigint,
         (300 + random() * 12000)::bigint,
         (500 + random() * 20000)::bigint,
         now() - (random() * interval '365 days'),
         'COMPLETED'
  from generate_series(1, 100000) g;

  -- Keep the row-level arithmetic consistent, so reports over this data are meaningful.
  update public.sales set total = subtotal, amount_paid = subtotal
   where tenant_id = v_tenant_id;

  -- ~5 line items per sale.
  insert into public.sale_items
    (sale_id, tenant_id, branch_id, product_id, line_number, product_name, product_sku,
     quantity, unit_price, unit_cost, line_total)
  select s.id, v_tenant_id, v_branch_id, p.id, ln,
         p.name, p.sku, 1, p.average_cost + 500, p.average_cost, p.average_cost + 500
  from public.sales s
  cross join lateral (select generate_series(1, 5) as ln) lines
  join lateral (
    select id, name, sku, average_cost from public.products
    where tenant_id = v_tenant_id offset floor(random() * 9990) limit 1
  ) p on true
  where s.tenant_id = v_tenant_id;

  insert into public.sale_payments (sale_id, tenant_id, branch_id, method, amount)
  select s.id, v_tenant_id, v_branch_id, 'CASH', s.total
  from public.sales s where s.tenant_id = v_tenant_id;

  -- 100,000 inventory movements.
  insert into public.inventory_movements
    (tenant_id, branch_id, product_id, movement_type, quantity, balance_after, unit_cost, occurred_at)
  select v_tenant_id, v_branch_id, si.product_id, 'SALE', -1, 99, si.unit_cost, s.sold_at
  from public.sale_items si
  join public.sales s on s.id = si.sale_id
  where si.tenant_id = v_tenant_id
  limit 100000;

  perform set_config('request.jwt.claims', '', true);
end
$$;

analyze;
