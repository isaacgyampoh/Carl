/**
 * Carl's performance probe.
 *
 * Generates realistic volume, then reports the query plan for every path a person actually
 * waits on. Three decisions make the numbers meaningful:
 *
 *   1. **Volume is generated server-side** with `generate_series`. Inserting a hundred
 *      thousand sales one statement at a time over a network connection would take hours
 *      and would measure the network.
 *
 *   2. **Each stage is its own statement**, timed separately. A single DO block hides where
 *      the time went, and on a hosted database it simply hits the statement timeout with
 *      nothing to show for it.
 *
 *   3. **Plans are taken as the cashier**, not as the owner of the database. RLS predicates
 *      are part of the query, and an EXPLAIN run as a superuser silently omits them. A
 *      measurement that skips the security layer measures a system Carl does not ship.
 *
 * DESTRUCTIVE. Refuses to run without CARL_ALLOW_DESTRUCTIVE_DB_TESTS=yes.
 *
 *   SUPABASE_DB_URL=... CARL_ALLOW_DESTRUCTIVE_DB_TESTS=yes pnpm db:perf
 */
import pg from 'pg';

const PERF_ADMIN = '00000000-0000-4000-8000-0000000000ff';

/** Volume. Tuned so the whole probe finishes, and reported as what it actually is. */
const PRODUCTS = Number(process.env.CARL_PERF_PRODUCTS ?? 10_000);
const SALES = Number(process.env.CARL_PERF_SALES ?? 100_000);
const LINES_PER_SALE = Number(process.env.CARL_PERF_LINES ?? 5);

const stages = (tenantId, branchId) => [
  {
    name: `${PRODUCTS.toLocaleString()} products`,
    sql: `insert into public.products
            (tenant_id, name, sku, unit, average_cost, reorder_level, tax_mode, tax_rate)
          select $1, 'Product ' || g, 'SKU-' || lpad(g::text, 6, '0'), 'unit',
                 (100 + (random() * 5000))::bigint, 20, 'INCLUSIVE', 15
            from generate_series(1, $2) g`,
    params: [tenantId, PRODUCTS],
  },
  {
    name: 'retail prices',
    sql: `insert into public.product_prices (tenant_id, product_id, tier, amount)
          select $1, p.id, 'RETAIL', p.average_cost + 500
            from public.products p where p.tenant_id = $1`,
    params: [tenantId],
  },
  {
    name: 'barcodes',
    sql: `insert into public.product_barcodes (tenant_id, product_id, barcode)
          select $1, p.id, '50' || lpad((row_number() over (order by p.sku))::text, 11, '0')
            from public.products p where p.tenant_id = $1`,
    params: [tenantId],
  },
  {
    name: 'opening stock',
    sql: `insert into public.inventory (tenant_id, branch_id, product_id, quantity, reorder_level)
          select $1, $2, p.id, 100, 20 from public.products p where p.tenant_id = $1`,
    params: [tenantId, branchId],
  },
  {
    name: `${SALES.toLocaleString()} sales over a year`,
    // The arithmetic is computed once per row rather than randomised per column: the schema
    // enforces `total = subtotal - discount + tax`, and it is right to. Volume that violates
    // Carl's own invariants would measure a database Carl never contains.
    sql: `insert into public.sales
            (tenant_id, branch_id, sale_number, cashier_id, subtotal, discount_amount,
             tax_amount, total, cost_total, amount_paid, sold_at, status)
          select $1, $2, 'PERF-' || lpad(g::text, 8, '0'), $3,
                 line.subtotal, 0, 0, line.subtotal,
                 (line.subtotal * 0.6)::bigint, line.subtotal,
                 now() - (random() * interval '365 days'), 'COMPLETED'
            from generate_series(1, $4) g
            cross join lateral (select (500 + random() * 20000)::bigint as subtotal) line`,
    params: [tenantId, branchId, PERF_ADMIN, SALES],
  },
  {
    name: 'numbering the catalogue',
    // A numbered copy, so line items can pick a product by arithmetic. The obvious form —
    // `offset floor(random() * n) limit 1` per row — reads the products table once for
    // every line item, which is half a million scans and slower than everything else here
    // put together.
    sql: `create unlogged table perf_products as
          select (row_number() over (order by p.sku)) - 1 as n, p.id, p.name, p.sku,
                 p.average_cost
            from public.products p where p.tenant_id = $1`,
    params: [tenantId],
  },
  { name: 'indexing it', sql: 'create index on perf_products (n)', params: [] },
  {
    name: `${(SALES * LINES_PER_SALE).toLocaleString()} line items`,
    sql: `insert into public.sale_items
            (sale_id, tenant_id, branch_id, product_id, line_number, product_name,
             product_sku, quantity, unit_price, unit_cost, line_total)
          select numbered.id, $1, $2, p.id, ln, p.name, p.sku, 1,
                 p.average_cost + 500, p.average_cost, p.average_cost + 500
            from (
              select s.id, (row_number() over (order by s.sale_number)) as rn
                from public.sales s where s.tenant_id = $1
            ) numbered
            cross join generate_series(1, $3) as ln
            -- Coprime multipliers, so lines spread across the catalogue.
            join perf_products p on p.n = ((numbered.rn * 7 + ln * 13) % $4)`,
    params: [tenantId, branchId, LINES_PER_SALE, PRODUCTS],
  },
  {
    name: 'payments',
    sql: `insert into public.sale_payments (sale_id, tenant_id, branch_id, method, amount)
          select s.id, $1, $2, 'CASH', s.total from public.sales s where s.tenant_id = $1`,
    params: [tenantId, branchId],
  },
  {
    name: 'inventory ledger',
    sql: `insert into public.inventory_movements
            (tenant_id, branch_id, product_id, movement_type, quantity, balance_after,
             unit_cost, occurred_at)
          select $1, $2, si.product_id, 'SALE', -1, 99, si.unit_cost, s.sold_at
            from public.sale_items si
            join public.sales s on s.id = si.sale_id
           where si.tenant_id = $1
           limit $3`,
    params: [tenantId, branchId, SALES],
  },
  { name: 'analyze', sql: 'analyze', params: [] },
];

/**
 * The paths a person waits on.
 *
 * Each carries a budget taken from what the person is doing while it runs. A cashier
 * holding an item cannot wait 200ms for a barcode; a manager opening a yearly report can
 * wait a second.
 */
const QUERIES = [
  {
    name: 'Barcode scan',
    why: 'A cashier is holding the item. The hottest path in the product.',
    budgetMs: 50,
    sql: `select p.id, p.name, p.sku, pp.amount
            from public.product_barcodes b
            join public.products p on p.id = b.product_id
            left join public.product_prices pp
              on pp.product_id = p.id and pp.tier = 'RETAIL' and pp.effective_to is null
           where b.barcode = $1`,
    params: ['50000000005000'],
  },
  {
    name: 'Product search by name',
    why: 'Typed at the till when an item has no barcode.',
    budgetMs: 200,
    sql: `select p.id, p.name, p.sku from public.products p
           where p.is_active and p.name ilike $1 order by p.name limit 50`,
    params: ['%Product 5%'],
  },
  {
    name: 'Sales list, first page',
    why: 'The first screen after the till. Opened constantly.',
    budgetMs: 200,
    sql: `select s.id, s.sale_number, s.total, s.sold_at
            from public.sales s order by s.sold_at desc limit 50`,
    params: [],
  },
  {
    name: "Today's takings",
    why: 'Checked several times a day, and at closing.',
    budgetMs: 400,
    sql: `select count(*), coalesce(sum(s.total), 0) from public.sales s
           where s.sold_at >= now() - interval '1 day' and s.status = 'COMPLETED'`,
    params: [],
  },
  {
    name: 'Low stock',
    why: 'A threshold evaluated per branch. Drives reordering.',
    budgetMs: 400,
    sql: `select i.product_id, i.quantity, i.reorder_level from public.inventory i
           where i.quantity <= i.reorder_level limit 100`,
    params: [],
  },
  {
    name: 'Inventory ledger for one product',
    why: 'Opened when a stock figure is disputed.',
    budgetMs: 300,
    sql: `select m.occurred_at, m.movement_type, m.quantity, m.balance_after
            from public.inventory_movements m
           where m.product_id = (select id from public.products order by sku limit 1)
           order by m.occurred_at desc limit 100`,
    params: [],
  },
  {
    name: 'Best sellers over a year',
    why: 'The heaviest report Carl offers. A manager can wait, but not forever.',
    budgetMs: 5000,
    sql: `select si.product_id, si.product_name, sum(si.quantity) as sold,
                 sum(si.line_total) as revenue
            from public.sale_items si
            join public.sales s on s.id = si.sale_id
           where s.sold_at >= now() - interval '365 days' and s.status = 'COMPLETED'
           group by si.product_id, si.product_name
           order by revenue desc limit 20`,
    params: [],
  },
];

/** Sequential scans in a plan — where an index was expected and not used. */
function sequentialScans(plan) {
  const found = [];
  const walk = (node) => {
    if (node['Node Type'] === 'Seq Scan') {
      found.push({ table: node['Relation Name'], rows: node['Actual Rows'] });
    }
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(plan.Plan);
  return found;
}

async function main() {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) throw new Error('SUPABASE_DB_URL is required.');
  if (process.env.CARL_ALLOW_DESTRUCTIVE_DB_TESTS !== 'yes') {
    throw new Error(
      'This probe writes hundreds of thousands of rows and does not clean up.\n' +
        'Point it at a disposable verification project and set\n' +
        'CARL_ALLOW_DESTRUCTIVE_DB_TESTS=yes to confirm.',
    );
  }

  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
    // Generation is slow by nature. The queries being *measured* are never given this
    // much room — if one of those needed it, that would be the finding.
    statement_timeout: 900_000,
  });
  await client.connect();

  try {
    // A clean slate. The probe is meaningless run twice on top of itself.
    await client.query('drop table if exists perf_products');
    await client.query(`delete from public.tenants where slug = 'perf-test'`);

    await client.query(
      `insert into auth.users (id, email) values ($1, 'perf@carl.test')
       on conflict (id) do nothing`,
      [PERF_ADMIN],
    );
    await client.query(
      `insert into public.profiles (id, email, full_name)
       values ($1, 'perf@carl.test', 'Performance Probe') on conflict (id) do nothing`,
      [PERF_ADMIN],
    );
    await client.query(
      `insert into public.platform_admins (user_id) values ($1) on conflict do nothing`,
      [PERF_ADMIN],
    );

    await client.query(`select set_config('request.jwt.claims', $1, false)`, [
      JSON.stringify({ sub: PERF_ADMIN, role: 'authenticated' }),
    ]);

    const { rows: provisioned } = await client.query(
      `select tenant_id, branch_id from public.provision_tenant(
         'perf-test', 'Performance Test Co', 'perf@carl.test', 'Performance Probe',
         $1, 'Main', 'main', 'ACTIVE', 14)`,
      [PERF_ADMIN],
    );
    const { tenant_id: tenantId, branch_id: branchId } = provisioned[0];

    console.log('Generating volume\n');
    for (const stage of stages(tenantId, branchId)) {
      const started = Date.now();
      const result = await client.query(stage.sql, stage.params);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `  ${stage.name.padEnd(28)} ${seconds.padStart(7)}s` +
          (result.rowCount ? `  (${result.rowCount.toLocaleString()} rows)` : ''),
      );
    }

    // As the cashier from here on, so RLS is in every plan below.
    await client.query('set role authenticated');

    console.log('\nQuery plans, as an authenticated user — RLS applies\n');
    const results = [];

    for (const query of QUERIES) {
      const { rows } = await client.query(
        `explain (analyze, buffers, format json) ${query.sql}`,
        query.params,
      );
      const plan = rows[0]['QUERY PLAN'][0];
      const ms = plan['Execution Time'];
      const scans = sequentialScans(plan);
      const verdict = ms <= query.budgetMs ? 'PASS' : 'SLOW';
      results.push({ ...query, ms, verdict, scans });

      console.log(`${verdict === 'PASS' ? '✓' : '✗'} ${query.name}  —  ${ms.toFixed(1)} ms (budget ${query.budgetMs} ms)`);
      console.log(`    ${query.why}`);
      if (scans.length > 0) {
        console.log(
          `    sequential scans: ${scans.map((s) => `${s.table} (${s.rows.toLocaleString()} rows)`).join(', ')}`,
        );
      }
    }

    await client.query('reset role');

    const { rows: sizes } = await client.query(
      `select relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) as total
         from pg_stat_user_tables
        where schemaname = 'public' and n_live_tup > 1000
        order by pg_total_relation_size(relid) desc limit 12`,
    );
    console.log('\nTable sizes');
    for (const row of sizes) {
      console.log(
        `  ${row.relname.padEnd(24)} ${String(Number(row.n_live_tup).toLocaleString()).padStart(11)} rows  ${row.total}`,
      );
    }

    const slow = results.filter((r) => r.verdict === 'SLOW');
    console.log(
      `\n${results.length - slow.length}/${results.length} within budget.` +
        (slow.length > 0 ? ` Over budget: ${slow.map((s) => s.name).join(', ')}` : ''),
    );
    process.exitCode = slow.length > 0 ? 1 : 0;
  } finally {
    await client.query('drop table if exists perf_products').catch(() => undefined);
    await client.end();
  }
}

await main();
