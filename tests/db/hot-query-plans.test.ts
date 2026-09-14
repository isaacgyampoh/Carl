import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { addMember, createProduct, createTenant, type TenantFixture } from '../support/fixtures.js';

/**
 * The policies are resolved once per statement, not once per row.
 *
 * That is the whole of what `20260101004300_readable_sets.sql` changed, and it is a property
 * of the plan rather than of a stopwatch, so it can be asserted here instead of being
 * re-measured by hand. In a plan it is the difference between:
 *
 *   InitPlan — evaluated once, its answer substituted as a parameter; and
 *   SubPlan  — evaluated again for every row the scan touches.
 *
 * Measured on 20,000 sales while this was written (PGlite, best of three):
 *
 *   the exact row count every paged screen asks for   2,016 ms  ->  10.8 ms
 *   the first page for a cashier, who sees only theirs 2,278 ms  ->   6.0 ms
 *   today's takings                                       73 ms  ->   0.7 ms
 *
 * The first page for a manager was never the problem — an index gave it the newest fifty
 * rows and the policy ran fifty times. It is the queries that must touch every row of a
 * business's history where a per-row permission lookup decides whether a screen opens in a
 * moment or in two seconds.
 */
describe('the read policies are resolved once per statement', () => {
  let db: TestDatabase;
  let shop: TenantFixture;
  let managerUserId: string;
  let cashierUserId: string;
  const SALES = 4_000;

  beforeAll(async () => {
    db = await createTestDatabase();
    await db.reset();

    shop = await createTenant(db, { name: 'Busy Shop' });
    await createProduct(db, shop.tenantId, { name: 'Sugar 1kg', sku: 'SUG-1' });
    // branch_manager holds sales.view_all; cashier holds sales.view and sees only its own.
    ({ userId: managerUserId } = await addMember(db, shop.tenantId, {
      roleKey: 'branch_manager',
    }));
    ({ userId: cashierUserId } = await addMember(db, shop.tenantId, { roleKey: 'cashier' }));

    await db.asServiceRole(() =>
      db.query(
        `insert into public.sales
           (tenant_id, branch_id, sale_number, cashier_id, subtotal, discount_amount,
            tax_amount, total, cost_total, amount_paid, sold_at, status)
         select $1, $2, 'PLAN-' || lpad(g::text, 7, '0'), $3, 1000, 0, 0, 1000, 600, 1000,
                now() - (g * interval '5 minutes'), 'COMPLETED'
           from generate_series(1, $4) g`,
        [shop.tenantId, shop.branchId, shop.ownerUserId, SALES],
      ),
    );
    await db.asAdmin(() => db.query('analyze'));
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  const planFor = async (userId: string, sql: string, params: unknown[]): Promise<string> => {
    const { rows } = await db.asUser(userId, () =>
      db.query<{ 'QUERY PLAN': string }>(`explain (costs off) ${sql}`, params),
    );
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  };

  /*
   * The queries Carl's own screens send, including the `tenant_id` filter every one of them
   * applies. Leaving that filter out measures a query the product never runs.
   */
  const hot = (tenantId: string) => ({
    'the sales list': [
      `select s.id, s.sale_number, s.total, s.sold_at from public.sales s
        where s.tenant_id = $1 order by s.sold_at desc limit 50`,
      [tenantId],
    ],
    'the exact count beside a paged list': [
      `select count(*) from public.sales s where s.tenant_id = $1`,
      [tenantId],
    ],
    "today's takings": [
      `select count(*), coalesce(sum(s.total), 0) from public.sales s
        where s.tenant_id = $1 and s.sold_at >= now() - interval '1 day'
          and s.status = 'COMPLETED'`,
      [tenantId],
    ],
    'a product search': [
      `select p.id, p.name from public.products p
        where p.tenant_id = $1 and p.is_active and p.name ilike $2 order by p.name limit 50`,
      [tenantId, '%Sugar%'],
    ],
  });

  it.each(Object.keys(hot('x')))('%s asks the permission question once', async (name) => {
    const [sql, params] = hot(shop.tenantId)[name as 'the sales list'];
    for (const who of [managerUserId, cashierUserId]) {
      const plan = await planFor(who, sql as string, params as unknown[]);
      expect(plan, `a per-row permission lookup is back:\n${plan}`).not.toMatch(/SubPlan/);
    }
  });

  it('reads the sales list through an index rather than scanning every sale', async () => {
    const [sql, params] = hot(shop.tenantId)['the sales list'];
    const plan = await planFor(managerUserId, sql as string, params as unknown[]);
    expect(plan, `the planner chose:\n${plan}`).not.toMatch(/Seq Scan on sales/);
  });

  it('still shows a manager every sale, and a cashier only their own', async () => {
    // A fast plan is worth nothing if the rule changed with it. Belt and braces alongside
    // readable-sets.test.ts, which asserts the sets themselves.
    const seen = async (userId: string) =>
      (
        await db.asUser(userId, () =>
          db.query<{ n: number }>(
            'select count(*)::int as n from public.sales where tenant_id = $1',
            [shop.tenantId],
          ),
        )
      ).rows[0]!.n;

    expect(await seen(managerUserId), 'sales.view_all should see the whole branch').toBe(SALES);
    // Every sale here was rung up by the owner, so a cashier's own list is empty.
    expect(await seen(cashierUserId), 'sales.view should see only their own').toBe(0);
  });
});
