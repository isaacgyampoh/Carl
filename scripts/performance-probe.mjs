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
/* The rest of a shop's year: the books, not the till. */
const CUSTOMERS = Number(process.env.CARL_PERF_CUSTOMERS ?? 5_000);
const SUPPLIERS = 200;
const EXPENSES = 20_000;
const PURCHASES = 2_000;
const RETURNS = 1_000;
const SESSIONS = 700;
const AUDIT = 50_000;
const NOTIFICATIONS = 5_000;
const TRANSFERS = 500;

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
    name: `${CUSTOMERS.toLocaleString()} customers`,
    sql: `insert into public.customers (tenant_id, name, phone, default_tier)
          select $1, 'Customer ' || g, '02' || lpad(g::text, 8, '0'), 'RETAIL'
            from generate_series(1, $2) g`,
    params: [tenantId, CUSTOMERS],
  },
  {
    // Numbered for the same reason the catalogue is: picking a row by arithmetic rather
    // than by scanning the table once per sale.
    name: 'numbering the customers',
    sql: `create unlogged table perf_customers as
          select (row_number() over (order by c.name)) - 1 as n, c.id
            from public.customers c where c.tenant_id = $1`,
    params: [tenantId],
  },
  { name: 'indexing them', sql: 'create index on perf_customers (n)', params: [] },
  {
    name: `${SUPPLIERS.toLocaleString()} suppliers`,
    sql: `insert into public.suppliers (tenant_id, name, phone)
          select $1, 'Supplier ' || g, '03' || lpad(g::text, 8, '0')
            from generate_series(1, $2) g`,
    params: [tenantId, SUPPLIERS],
  },
  {
    name: 'expense categories',
    sql: `insert into public.expense_categories (tenant_id, name)
          select $1, x from unnest(array['Rent', 'Transport', 'Utilities', 'Wages', 'Supplies']) x`,
    params: [tenantId],
  },
  {
    name: 'a second branch, to move stock to',
    sql: `insert into public.branches (tenant_id, code, name) values ($1, 'perf2', 'Second Branch')`,
    params: [tenantId],
  },
  {
    name: 'a register to open the till on',
    sql: `insert into public.cash_registers (tenant_id, branch_id, name) values ($1, $2, 'Counter 1')`,
    params: [tenantId, branchId],
  },
  {
    name: `${SALES.toLocaleString()} sales over a year`,
    // The arithmetic is computed once per row rather than randomised per column: the schema
    // enforces `total = subtotal - discount + tax`, and it is right to. Volume that violates
    // Carl's own invariants would measure a database Carl never contains.
    sql: `insert into public.sales
            (tenant_id, branch_id, sale_number, cashier_id, customer_id, subtotal,
             discount_amount, tax_amount, total, cost_total, amount_paid, sold_at, status)
          select $1, $2, 'PERF-' || lpad(g::text, 8, '0'), $3, c.id,
                 line.subtotal, 0, 0, line.subtotal,
                 (line.subtotal * 0.6)::bigint, line.subtotal,
                 now() - (random() * interval '365 days'), 'COMPLETED'
            from generate_series(1, $4) g
            cross join lateral (select (500 + random() * 20000)::bigint as subtotal) line
            -- A third of a shop's sales are to somebody it knows by name.
            left join perf_customers c on g % 3 = 0 and c.n = (g * 7) % $5`,
    params: [tenantId, branchId, PERF_ADMIN, SALES, CUSTOMERS],
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
  // Five statements rather than one. A single half-million-row insert is long enough that a
  // hosted database under load closes the connection part way through it, which ends the run.
  ...Array.from({ length: LINES_PER_SALE }, (_, index) => ({
    name: `line ${index + 1} of every sale`,
    sql: `insert into public.sale_items
            (sale_id, tenant_id, branch_id, product_id, line_number, product_name,
             product_sku, quantity, unit_price, unit_cost, line_total)
          select numbered.id, $1, $2, p.id, $3, p.name, p.sku, 1,
                 p.average_cost + 500, p.average_cost, p.average_cost + 500
            from (
              select s.id, (row_number() over (order by s.sale_number)) as rn
                from public.sales s where s.tenant_id = $1
            ) numbered
            -- Coprime multipliers, so lines spread across the catalogue.
            join perf_products p on p.n = ((numbered.rn * 7 + $3 * 13) % $4)`,
    params: [tenantId, branchId, index + 1, PRODUCTS],
  })),
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
  {
    name: `${EXPENSES.toLocaleString()} expenses`,
    sql: `insert into public.expenses
            (tenant_id, branch_id, category_id, reference, description, amount, method,
             status, expense_date, created_by)
          select $1, $2,
                 (select id from public.expense_categories
                   where tenant_id = $1 order by name offset (g % 5) limit 1),
                 'EXP-' || lpad(g::text, 7, '0'), 'Expense ' || g,
                 (1000 + random() * 50000)::bigint, 'CASH', 'PAID',
                 (now() - (random() * interval '365 days'))::date, $3
            from generate_series(1, $4) g`,
    params: [tenantId, branchId, PERF_ADMIN, EXPENSES],
  },
  {
    name: `${PURCHASES.toLocaleString()} purchases`,
    sql: `insert into public.purchases
            (tenant_id, branch_id, supplier_id, reference, status, payment_status,
             subtotal, total, amount_paid, ordered_at, received_at, created_by)
          select $1, $2,
                 (select id from public.suppliers where tenant_id = $1
                   order by name offset (g % $5) limit 1),
                 'PO-' || lpad(g::text, 6, '0'), 'RECEIVED', 'PAID',
                 v.amount, v.amount, v.amount,
                 now() - (random() * interval '365 days'),
                 now() - (random() * interval '360 days'), $3
            from generate_series(1, $4) g
            cross join lateral (select (10000 + random() * 500000)::bigint as amount) v`,
    params: [tenantId, branchId, PERF_ADMIN, PURCHASES, SUPPLIERS],
  },
  {
    name: 'purchase lines',
    sql: `insert into public.purchase_items
            (purchase_id, tenant_id, product_id, line_number, quantity_ordered,
             quantity_received, unit_cost, line_total)
          select po.id, $1, p.id, ln, 10, 10, p.average_cost, p.average_cost * 10
            from (
              select id, (row_number() over (order by reference)) as rn
                from public.purchases where tenant_id = $1
            ) po
            cross join generate_series(1, 5) as ln
            join perf_products p on p.n = ((po.rn * 11 + ln * 3) % $2)`,
    params: [tenantId, PRODUCTS],
  },
  {
    name: `${RETURNS.toLocaleString()} returns`,
    sql: `insert into public.sale_returns
            (tenant_id, branch_id, sale_id, return_number, reason, subtotal, total,
             refund_method, processed_by, returned_at)
          select $1, $2, s.id, 'RET-' || lpad(s.rn::text, 6, '0'), 'Changed their mind',
                 (s.total * 0.2)::bigint, (s.total * 0.2)::bigint, 'CASH', $3, s.sold_at
            from (
              select id, total, sold_at, (row_number() over (order by sale_number)) as rn
                from public.sales where tenant_id = $1 limit $4
            ) s`,
    params: [tenantId, branchId, PERF_ADMIN, RETURNS],
  },
  {
    name: `${SESSIONS.toLocaleString()} till sessions`,
    sql: `insert into public.cash_sessions
            (tenant_id, branch_id, register_id, status, opening_float, cash_sales,
             expected_cash, counted_cash, variance, opened_by, opened_at, closed_at)
          select $1, $2, (select id from public.cash_registers where tenant_id = $1 limit 1),
                 'CLOSED', 20000, v.takings, v.takings + 20000, v.takings + 20000, 0, $3,
                 now() - (g * interval '12 hours'), now() - (g * interval '12 hours') + interval '9 hours'
            from generate_series(1, $4) g
            cross join lateral (select (50000 + random() * 900000)::bigint as takings) v`,
    params: [tenantId, branchId, PERF_ADMIN, SESSIONS],
  },
  {
    name: 'cash movements',
    sql: `insert into public.cash_movements
            (session_id, tenant_id, branch_id, movement_type, amount, reason, performed_by,
             occurred_at)
          select cs.id, $1, $2, 'OUT', 5000, 'Change for the float', $3, cs.opened_at
            from public.cash_sessions cs where cs.tenant_id = $1`,
    params: [tenantId, branchId, PERF_ADMIN],
  },
  {
    name: `${TRANSFERS.toLocaleString()} stock transfers`,
    sql: `insert into public.stock_transfers
            (tenant_id, reference, from_branch_id, to_branch_id, status, requested_by,
             requested_at, received_at)
          select $1, 'TRF-' || lpad(g::text, 6, '0'), $2,
                 (select id from public.branches where tenant_id = $1 and code = 'perf2'),
                 'RECEIVED', $3, now() - (random() * interval '365 days'),
                 now() - (random() * interval '360 days')
            from generate_series(1, $4) g`,
    params: [tenantId, branchId, PERF_ADMIN, TRANSFERS],
  },
  {
    name: 'transfer lines',
    sql: `insert into public.stock_transfer_items
            (transfer_id, tenant_id, product_id, quantity_requested, quantity_sent,
             quantity_received, unit_cost)
          select t.id, $1, p.id, 5, 5, 5, p.average_cost
            from (
              select id, (row_number() over (order by reference)) as rn
                from public.stock_transfers where tenant_id = $1
            ) t
            cross join generate_series(1, 4) as ln
            join perf_products p on p.n = ((t.rn * 17 + ln * 5) % $2)`,
    params: [tenantId, PRODUCTS],
  },
  {
    name: `${AUDIT.toLocaleString()} audit entries`,
    sql: `insert into public.audit_logs
            (tenant_id, branch_id, actor_id, actor_email, action, entity_type, occurred_at)
          select $1, $2, $3, 'perf@carl.test',
                 -- The schema requires SHOUTING_SNAKE_CASE, and is right to: an audit
                 -- action is a name, not a sentence.
                 (array['SALE_CREATED', 'PRODUCT_UPDATED', 'STOCK_ADJUSTED',
                        'STAFF_PIN_CHANGED', 'EXPENSE_APPROVED'])[1 + (g % 5)],
                 (array['sale', 'product', 'inventory', 'membership', 'expense'])[1 + (g % 5)],
                 now() - (random() * interval '365 days')
            from generate_series(1, $4) g`,
    params: [tenantId, branchId, PERF_ADMIN, AUDIT],
  },
  {
    name: `${NOTIFICATIONS.toLocaleString()} notifications`,
    sql: `insert into public.notifications
            (tenant_id, branch_id, user_id, kind, severity, title, created_at)
          select $1, $2, $3, 'LOW_STOCK', 'WARNING', 'Product ' || g || ' is running low',
                 now() - (random() * interval '90 days')
            from generate_series(1, $4) g`,
    params: [tenantId, branchId, PERF_ADMIN, NOTIFICATIONS],
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
/**
 * The paths a person waits on.
 *
 * Each is the query Carl's own screen sends, including the `tenant_id` filter every one of
 * them applies. That filter is not the security control — Row Level Security is — but leaving
 * it out measures a query the product never runs, and the plan for "every sale on the
 * platform" is not the plan for "every sale in this shop".
 *
 * Each carries a budget taken from what the person is doing while it runs. A cashier holding
 * an item cannot wait 200ms for a barcode; a manager opening a yearly report can wait a
 * second.
 */
const queries = (tenantId, branchId) => [
  {
    name: 'Barcode scan',
    why: 'A cashier is holding the item. The hottest path in the product.',
    budgetMs: 50,
    sql: `select p.id, p.name, p.sku, pp.amount
            from public.product_barcodes b
            join public.products p on p.id = b.product_id
            left join public.product_prices pp
              on pp.product_id = p.id and pp.tier = 'RETAIL' and pp.effective_to is null
           where b.barcode = $1 and b.tenant_id = $2`,
    params: ['50000000005000', tenantId],
  },
  {
    name: 'Product search by name',
    why: 'Typed at the till when an item has no barcode.',
    budgetMs: 200,
    sql: `select p.id, p.name, p.sku from public.products p
           where p.tenant_id = $2 and p.is_active and p.name ilike $1
           order by p.name limit 50`,
    params: ['%Product 5%', tenantId],
  },
  {
    name: 'Sales list, first page',
    why: 'The first screen after the till. Opened constantly.',
    budgetMs: 200,
    sql: `select s.id, s.sale_number, s.total, s.sold_at
            from public.sales s where s.tenant_id = $1
           order by s.sold_at desc limit 50`,
    params: [tenantId],
  },
  {
    name: 'Sales list, the row count beside it',
    why: 'Every paged screen asks for an exact count, which reads the whole set.',
    budgetMs: 400,
    sql: `select count(*) from public.sales s where s.tenant_id = $1`,
    params: [tenantId],
  },
  {
    name: "Today's takings",
    why: 'Checked several times a day, and at closing.',
    budgetMs: 400,
    sql: `select count(*), coalesce(sum(s.total), 0) from public.sales s
           where s.tenant_id = $1 and s.sold_at >= now() - interval '1 day'
             and s.status = 'COMPLETED'`,
    params: [tenantId],
  },
  {
    name: 'Low stock',
    why: 'A threshold evaluated per branch. Drives reordering.',
    budgetMs: 400,
    sql: `select i.product_id, i.quantity, i.reorder_level from public.inventory i
           where i.tenant_id = $1 and i.branch_id = $2 and i.quantity <= i.reorder_level
           order by i.quantity limit 100`,
    params: [tenantId, branchId],
  },
  {
    name: 'Inventory ledger for one product',
    why: 'Opened when a stock figure is disputed.',
    budgetMs: 300,
    sql: `select m.occurred_at, m.movement_type, m.quantity, m.balance_after
            from public.inventory_movements m
           where m.tenant_id = $1
             and m.product_id = (select id from public.products where tenant_id = $1
                                  order by sku limit 1)
           order by m.occurred_at desc limit 100`,
    params: [tenantId],
  },
  {
    name: 'Customer list, first page',
    why: 'Opened to find somebody standing at the counter.',
    budgetMs: 200,
    sql: `select c.id, c.name, c.phone, c.balance from public.customers c
           where c.tenant_id = $1 order by c.name limit 50`,
    params: [tenantId],
  },
  {
    name: 'Customer search by name',
    why: 'Typed while the customer waits.',
    budgetMs: 200,
    sql: `select c.id, c.name, c.phone from public.customers c
           where c.tenant_id = $2 and c.name ilike $1 order by c.name limit 25`,
    params: ['%Customer 4%', tenantId],
  },
  {
    name: "One customer's history",
    why: 'Opened to settle an argument about what they bought.',
    budgetMs: 300,
    sql: `select s.sale_number, s.total, s.sold_at from public.sales s
           where s.tenant_id = $1
             and s.customer_id = (select id from public.customers where tenant_id = $1
                                   order by name limit 1)
           order by s.sold_at desc limit 50`,
    params: [tenantId],
  },
  {
    name: 'Expenses, first page',
    why: 'Opened when the month is being closed.',
    budgetMs: 400,
    sql: `select e.reference, e.description, e.amount, e.expense_date from public.expenses e
           where e.tenant_id = $1 order by e.expense_date desc limit 50`,
    params: [tenantId],
  },
  {
    name: 'Purchases, first page',
    why: 'Opened to check what was ordered and what arrived.',
    budgetMs: 300,
    sql: `select p.reference, p.total, p.status, p.created_at from public.purchases p
           where p.tenant_id = $1 order by p.created_at desc limit 50`,
    params: [tenantId],
  },
  {
    name: "One supplier's purchases",
    why: 'Opened before paying a supplier.',
    budgetMs: 300,
    sql: `select p.reference, p.total, p.created_at from public.purchases p
           where p.tenant_id = $1
             and p.supplier_id = (select id from public.suppliers where tenant_id = $1
                                   order by name limit 1)
           order by p.created_at desc limit 50`,
    params: [tenantId],
  },
  {
    name: 'Returns for a month',
    why: 'Watched, because returns are where money leaves quietly.',
    budgetMs: 300,
    sql: `select r.return_number, r.total, r.returned_at from public.sale_returns r
           where r.tenant_id = $1 and r.returned_at >= now() - interval '30 days'
           order by r.returned_at desc limit 50`,
    params: [tenantId],
  },
  {
    name: 'Till sessions, first page',
    why: 'Opened at closing, and whenever the cash does not agree.',
    budgetMs: 300,
    sql: `select cs.opened_at, cs.closed_at, cs.expected_cash, cs.counted_cash, cs.variance
            from public.cash_sessions cs where cs.tenant_id = $1
           order by cs.opened_at desc limit 20`,
    params: [tenantId],
  },
  {
    name: 'Payment mix for a day',
    why: 'Cash against mobile money, which is how a shop reconciles.',
    budgetMs: 400,
    sql: `select sp.method, count(*), coalesce(sum(sp.amount), 0) from public.sale_payments sp
            join public.sales s on s.id = sp.sale_id
           where sp.tenant_id = $1 and s.sold_at >= now() - interval '1 day'
           group by sp.method`,
    params: [tenantId],
  },
  {
    name: 'Stock transfers, first page',
    why: 'Opened by a business running more than one branch.',
    budgetMs: 300,
    sql: `select t.reference, t.status, t.created_at from public.stock_transfers t
           where t.tenant_id = $1 order by t.created_at desc limit 50`,
    params: [tenantId],
  },
  {
    name: 'Audit log, first page',
    why: 'Opened when something is being investigated. It is never small.',
    budgetMs: 500,
    sql: `select a.occurred_at, a.action, a.entity_type, a.actor_email from public.audit_logs a
           where a.tenant_id = $1 order by a.occurred_at desc limit 50`,
    params: [tenantId],
  },
  {
    name: 'Unread notifications',
    why: 'Fetched on every page of the back office.',
    budgetMs: 200,
    sql: `select n.title, n.severity, n.created_at from public.notifications n
           where n.tenant_id = $1 and n.read_at is null
           order by n.created_at desc limit 20`,
    params: [tenantId],
  },
  {
    name: 'Best sellers over a year',
    why: 'The heaviest report Carl offers. A manager can wait, but not forever.',
    budgetMs: 5000,
    sql: `select si.product_id, si.product_name, sum(si.quantity) as sold,
                 sum(si.line_total) as revenue
            from public.sale_items si
            join public.sales s on s.id = si.sale_id
           where si.tenant_id = $1 and s.sold_at >= now() - interval '365 days'
             and s.status = 'COMPLETED'
           group by si.product_id, si.product_name
           order by revenue desc limit 20`,
    params: [tenantId],
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

  /*
   * A query being measured can take the connection down with it — a statement timeout on a
   * hosted database closes the socket, and the first run of this probe died on its third
   * query with "Connection terminated unexpectedly", reporting nothing about the nine
   * queries after it. Each measurement now gets a fresh connection and its own short
   * timeout, so a pathological query is a finding rather than the end of the run.
   */
  const connect = async (timeoutMs) => {
    const c = new pg.Client({
      connectionString,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 20_000,
      statement_timeout: timeoutMs,
    });
    await c.connect();
    return c;
  };

  /** Long, because generating volume is slow by nature. Measurement never gets this much. */
  const client = await connect(900_000);
  // A hosted database can close a connection under load. Without this, node turns that into
  // an unhandled 'error' event and the whole run dies with a stack trace instead of a
  // sentence saying which stage was interrupted.
  client.on('error', () => undefined);

  try {
    /*
     * Generating a year of trade takes about six minutes, nearly all of it the half million
     * line items. Measuring the same volume before and after a change should not pay that
     * twice, so CARL_PERF_REUSE=yes measures whatever is already there.
     */
    const reuse = process.env.CARL_PERF_REUSE === 'yes';
    const { rows: existing } = await client.query(
      `select t.id as tenant_id, b.id as branch_id,
              (select count(*) from public.sales s where s.tenant_id = t.id) as sales
         from public.tenants t
         join public.branches b on b.tenant_id = t.id
        where t.slug = 'perf-test' limit 1`,
    );
    const alreadySeeded = reuse && existing.length > 0 && Number(existing[0].sales) > 0;

    if (!alreadySeeded) {
      // A clean slate. The probe is meaningless run twice on top of itself.
      await client.query('drop table if exists perf_products, perf_customers');

      /*
       * Carl's history is append-only — inventory movements, cash movements and the audit
       * log all refuse DELETE — so removing the previous run's tenant fails on its own
       * cascade. Those guards are lifted for the delete and put straight back.
       *
       * Only ever here, and only on the disposable project this probe refuses to run
       * without. It is never how Carl removes anything.
       */
      const { rows: guards } = await client.query(
        `select c.relname as table_name, t.tgname as trigger_name
           from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
           join pg_proc p on p.oid = t.tgfoid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and p.proname = 'reject_mutation' and not t.tgisinternal`,
      );
      for (const guard of guards) {
        await client.query(
          `alter table public.${guard.table_name} disable trigger ${guard.trigger_name}`,
        );
      }
      try {
        await client.query(`delete from public.tenants where slug = 'perf-test'`);
      } finally {
        for (const guard of guards) {
          await client.query(
            `alter table public.${guard.table_name} enable trigger ${guard.trigger_name}`,
          );
        }
      }
    }

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

    let tenantId;
    let branchId;
    if (alreadySeeded) {
      ({ tenant_id: tenantId, branch_id: branchId } = existing[0]);
      console.log(
        `Reusing the volume already in perf-test: ${Number(existing[0].sales).toLocaleString()} sales\n`,
      );
    } else {
      const { rows: provisioned } = await client.query(
        `select tenant_id, branch_id from public.provision_tenant(
           'perf-test', 'Performance Test Co', 'perf@carl.test', 'Performance Probe',
           $1, 'Main', 'main', 'ACTIVE', 14)`,
        [PERF_ADMIN],
      );
      ({ tenant_id: tenantId, branch_id: branchId } = provisioned[0]);
    }

    console.log(alreadySeeded ? '' : 'Generating volume\n');
    for (const stage of alreadySeeded ? [] : stages(tenantId, branchId)) {
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

    /** Long enough that a slow query is measured, short enough that a hopeless one is not. */
    const MEASURE_TIMEOUT_MS = Number(process.env.CARL_PERF_TIMEOUT_MS ?? 60_000);

    const QUERIES = queries(tenantId, branchId);
    for (const query of QUERIES) {
      const measurer = await connect(MEASURE_TIMEOUT_MS);
      let ms = null;
      let scans = [];
      let failure = null;
      try {
        await measurer.query(`select set_config('request.jwt.claims', $1, false)`, [
          JSON.stringify({ sub: PERF_ADMIN, role: 'authenticated' }),
        ]);
        await measurer.query('set role authenticated');
        const { rows } = await measurer.query(
          `explain (analyze, buffers, format json) ${query.sql}`,
          query.params,
        );
        const plan = rows[0]['QUERY PLAN'][0];
        ms = plan['Execution Time'];
        scans = sequentialScans(plan);
      } catch (error) {
        // A statement timeout closes the socket on a hosted database, so this is the shape
        // "too slow to measure" actually arrives in.
        failure =
          error.message.includes('timeout') || error.message.includes('terminated')
            ? `no answer within ${(MEASURE_TIMEOUT_MS / 1000).toFixed(0)}s`
            : error.message;
      } finally {
        await measurer.end().catch(() => undefined);
      }

      const verdict = failure ? 'SLOW' : ms <= query.budgetMs ? 'PASS' : 'SLOW';
      results.push({ ...query, ms, verdict, scans, failure });

      console.log(
        `${verdict === 'PASS' ? '✓' : '✗'} ${query.name}  —  ` +
          `${failure ?? `${ms.toFixed(1)} ms`} (budget ${query.budgetMs} ms)`,
      );
      console.log(`    ${query.why}`);
      if (scans.length > 0) {
        console.log(
          `    sequential scans: ${scans.map((s) => `${s.table} (${s.rows.toLocaleString()} rows)`).join(', ')}`,
        );
      }
    }

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
    await client.query('drop table if exists perf_products, perf_customers').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

await main();
