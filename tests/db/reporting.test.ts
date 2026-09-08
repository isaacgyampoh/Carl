import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import {
  addMember,
  createBranch,
  createProduct,
  createTenant,
  createUser,
} from '../support/fixtures.js';

/**
 * Reporting.
 *
 * Two things must hold, and the second is easy to lose.
 *
 *   1. The numbers are right.
 *   2. A report cannot see further than the caller can.
 *
 * Aggregates are a common way tenant isolation leaks: nobody thinks of `sum(total)` as
 * reading rows, but knowing a competitor's daily takings does not require seeing individual
 * sales. These functions are SECURITY INVOKER so RLS applies to every underlying row, and
 * these tests prove that is actually the case.
 */
describe('reporting', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.reset();
  });

  async function recordSale(
    tenantId: string,
    branchId: string,
    cashierId: string,
    options: {
      number: string;
      total: number;
      cost?: number;
      method?: string;
      soldAt?: string;
      status?: string;
    },
  ): Promise<string> {
    return db.asServiceRole(async () => {
      const { rows } = await db.query<{ id: string }>(
        `insert into sales (tenant_id, branch_id, sale_number, cashier_id, subtotal, total, cost_total, sold_at, status)
         values ($1, $2, $3, $4, $5, $5, $6, coalesce($7::timestamptz, now()), coalesce($8::sale_status, 'COMPLETED'))
         returning id`,
        [
          tenantId,
          branchId,
          options.number,
          cashierId,
          options.total,
          options.cost ?? 0,
          options.soldAt ?? null,
          options.status ?? null,
        ],
      );
      const saleId = rows[0]!.id;
      // A payment of zero is refused by CHECK, correctly: it records nothing.
      if (options.total > 0) {
        await db.query(
          `insert into sale_payments (sale_id, tenant_id, branch_id, method, amount, reference)
           values ($1, $2, $3, $4::payment_method, $5, case when $4 in ('MOMO','BANK_TRANSFER') then 'REF-1' end)`,
          [saleId, tenantId, branchId, options.method ?? 'CASH', options.total],
        );
      }
      return saleId;
    });
  }

  describe('tenant_dashboard_today', () => {
    it('totals only today’s completed sales', async () => {
      const t = await createTenant(db);
      const cashier = await createUser(db);

      await recordSale(t.tenantId, t.branchId, cashier, {
        number: 'S-1',
        total: 25000,
        cost: 15000,
      });
      await recordSale(t.tenantId, t.branchId, cashier, {
        number: 'S-2',
        total: 15000,
        cost: 9000,
      });
      // Yesterday: must not count toward today.
      await recordSale(t.tenantId, t.branchId, cashier, {
        number: 'S-3',
        total: 99900,
        soldAt: new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString(),
      });

      const { rows } = await db.asUser(t.ownerUserId, () =>
        db.query<{ sales_count: string; gross: string; cost: string; cash: string }>(
          `select * from tenant_dashboard_today($1, $2)`,
          [t.tenantId, t.branchId],
        ),
      );

      expect(Number(rows[0]!.sales_count)).toBe(2);
      expect(Number(rows[0]!.gross)).toBe(40000);
      expect(Number(rows[0]!.cost)).toBe(24000);
      expect(Number(rows[0]!.cash)).toBe(40000);
    });

    it('excludes voided sales', async () => {
      const t = await createTenant(db);
      const cashier = await createUser(db);

      await recordSale(t.tenantId, t.branchId, cashier, { number: 'S-1', total: 10000 });
      const voided = await recordSale(t.tenantId, t.branchId, cashier, {
        number: 'S-2',
        total: 50000,
      });
      await db.asServiceRole(() =>
        db.query(
          `update sales set status = 'VOIDED', voided_at = now(), void_reason = 'Keyed twice' where id = $1`,
          [voided],
        ),
      );

      const { rows } = await db.asUser(t.ownerUserId, () =>
        db.query<{ gross: string }>(`select * from tenant_dashboard_today($1, $2)`, [
          t.tenantId,
          t.branchId,
        ]),
      );
      expect(Number(rows[0]!.gross)).toBe(10000);
    });

    it('separates cash from mobile money', async () => {
      // The split a cashier reconciles the drawer against.
      const t = await createTenant(db);
      const cashier = await createUser(db);

      await recordSale(t.tenantId, t.branchId, cashier, {
        number: 'S-1',
        total: 30000,
        method: 'CASH',
      });
      await recordSale(t.tenantId, t.branchId, cashier, {
        number: 'S-2',
        total: 50000,
        method: 'MOMO',
      });

      const { rows } = await db.asUser(t.ownerUserId, () =>
        db.query<{ cash: string; momo: string; gross: string }>(
          `select * from tenant_dashboard_today($1, $2)`,
          [t.tenantId, t.branchId],
        ),
      );
      expect(Number(rows[0]!.cash)).toBe(30000);
      expect(Number(rows[0]!.momo)).toBe(50000);
      expect(Number(rows[0]!.gross)).toBe(80000);
    });

    it('returns another tenant’s figures as zero, not as their real total', async () => {
      // The aggregate leak. Passing someone else's tenant id must reveal nothing, and must
      // not error either - an error would confirm the tenant exists.
      const a = await createTenant(db);
      const b = await createTenant(db);
      const cashier = await createUser(db);

      await recordSale(b.tenantId, b.branchId, cashier, { number: 'B-1', total: 500000 });

      const { rows } = await db.asUser(a.ownerUserId, () =>
        db.query<{ sales_count: string; gross: string }>(
          `select * from tenant_dashboard_today($1, null)`,
          [b.tenantId],
        ),
      );
      expect(Number(rows[0]!.sales_count)).toBe(0);
      expect(Number(rows[0]!.gross)).toBe(0);
    });

    it('confines a branch-scoped user to their own branch’s figures', async () => {
      const t = await createTenant(db);
      const kumasi = await createBranch(db, t.tenantId, 'kumasi');
      const cashier = await createUser(db);

      await recordSale(t.tenantId, t.branchId, cashier, { number: 'ACC-1', total: 80000 });
      await recordSale(t.tenantId, kumasi, cashier, { number: 'KUM-1', total: 20000 });

      const { userId } = await addMember(db, t.tenantId, {
        roleKey: 'branch_manager',
        branchIds: [kumasi],
      });

      // Asking for every branch still yields only what RLS admits.
      const { rows } = await db.asUser(userId, () =>
        db.query<{ gross: string }>(`select * from tenant_dashboard_today($1, null)`, [t.tenantId]),
      );
      expect(Number(rows[0]!.gross)).toBe(20000);
    });
  });

  describe('sales_summary', () => {
    it('computes gross, cost and profit over a range', async () => {
      const t = await createTenant(db);
      const cashier = await createUser(db);

      await recordSale(t.tenantId, t.branchId, cashier, {
        number: 'S-1',
        total: 30000,
        cost: 18000,
      });
      await recordSale(t.tenantId, t.branchId, cashier, {
        number: 'S-2',
        total: 20000,
        cost: 11000,
      });

      const { rows } = await db.asUser(t.ownerUserId, () =>
        db.query<{
          sales_count: string;
          gross: string;
          cost: string;
          profit: string;
          average_sale: string;
        }>(
          `select * from sales_summary($1, now() - interval '1 day', now() + interval '1 day', $2)`,
          [t.tenantId, t.branchId],
        ),
      );

      expect(Number(rows[0]!.sales_count)).toBe(2);
      expect(Number(rows[0]!.gross)).toBe(50000);
      expect(Number(rows[0]!.cost)).toBe(29000);
      expect(Number(rows[0]!.profit)).toBe(21000);
      expect(Number(rows[0]!.average_sale)).toBe(25000);
    });

    it('returns zeroes rather than nulls for an empty range', async () => {
      // A dashboard rendering "GH₵null" is worse than one rendering "GH₵0.00".
      const t = await createTenant(db);
      const { rows } = await db.asUser(t.ownerUserId, () =>
        db.query<Record<string, string>>(
          `select * from sales_summary($1, now() - interval '1 day', now(), null)`,
          [t.tenantId],
        ),
      );
      for (const [column, value] of Object.entries(rows[0]!)) {
        expect(Number(value), `${column} came back null`).toBe(0);
      }
    });
  });

  describe('top_products', () => {
    it('ranks by revenue and reports the name recorded at sale time', async () => {
      // A product renamed or deleted later must still appear correctly in an old report.
      const t = await createTenant(db);
      const cashier = await createUser(db);
      const rice = await createProduct(db, t.tenantId, { name: 'Rice 5kg' });
      const oil = await createProduct(db, t.tenantId, { name: 'Cooking Oil 1L' });

      const sale = await recordSale(t.tenantId, t.branchId, cashier, { number: 'S-1', total: 0 });
      await db.asServiceRole(async () => {
        await db.query(
          `insert into sale_items (sale_id, tenant_id, branch_id, product_id, line_number, product_name, product_sku, quantity, unit_price, unit_cost, line_total)
           values ($1, $2, $3, $4, 1, 'Rice 5kg', 'RICE', 2, 20000, 12000, 40000),
                  ($1, $2, $3, $5, 2, 'Cooking Oil 1L', 'OIL', 3, 5000, 3000, 15000)`,
          [sale, t.tenantId, t.branchId, rice, oil],
        );
        await db.query(`update products set name = 'Renamed Later' where id = $1`, [rice]);
      });

      const { rows } = await db.asUser(t.ownerUserId, () =>
        db.query<{ product_name: string; revenue: string; profit: string }>(
          `select * from top_products($1, now() - interval '1 day', now() + interval '1 day', $2, 10)`,
          [t.tenantId, t.branchId],
        ),
      );

      expect(rows).toHaveLength(2);
      expect(rows[0]!.product_name).toBe('Rice 5kg');
      expect(Number(rows[0]!.revenue)).toBe(40000);
      expect(Number(rows[0]!.profit)).toBe(40000 - 12000 * 2);
    });

    it('clamps the limit so a caller cannot request an unbounded scan', async () => {
      const t = await createTenant(db);
      await expect(
        db.asUser(t.ownerUserId, () =>
          db.query(
            `select * from top_products($1, now() - interval '1 day', now(), null, 999999)`,
            [t.tenantId],
          ),
        ),
      ).resolves.toBeTruthy();
    });
  });

  describe('low_stock', () => {
    it('lists products at or below their reorder level, worst first', async () => {
      const t = await createTenant(db);
      const critical = await createProduct(db, t.tenantId, { name: 'Almost Out' });
      const fine = await createProduct(db, t.tenantId, { name: 'Plenty' });

      await db.asServiceRole(() =>
        db.query(
          `insert into inventory (tenant_id, branch_id, product_id, quantity, reorder_level) values
             ($1, $2, $3, 1, 20),
             ($1, $2, $4, 500, 20)`,
          [t.tenantId, t.branchId, critical, fine],
        ),
      );

      const { rows } = await db.asUser(t.ownerUserId, () =>
        db.query<{ product_name: string; shortfall: string }>(
          `select * from low_stock($1, $2, 50)`,
          [t.tenantId, t.branchId],
        ),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]!.product_name).toBe('Almost Out');
      expect(Number(rows[0]!.shortfall)).toBe(19);
    });

    it('ignores services, which have no stock to run out of', async () => {
      const t = await createTenant(db);
      const service = await createProduct(db, t.tenantId, { name: 'Delivery' });
      await db.asServiceRole(async () => {
        await db.query(`update products set is_stock_tracked = false where id = $1`, [service]);
        await db.query(
          `insert into inventory (tenant_id, branch_id, product_id, quantity, reorder_level)
           values ($1, $2, $3, 0, 10)`,
          [t.tenantId, t.branchId, service],
        );
      });

      const { rows } = await db.asUser(t.ownerUserId, () =>
        db.query(`select * from low_stock($1, $2, 50)`, [t.tenantId, t.branchId]),
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('stock_valuation', () => {
    it('values stock at cost and at retail', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId, { retailPrice: 25000 });

      await db.asServiceRole(async () => {
        await db.query(`update products set average_cost = 15000 where id = $1`, [product]);
        await db.query(
          `insert into inventory (tenant_id, branch_id, product_id, quantity) values ($1, $2, $3, 10)`,
          [t.tenantId, t.branchId, product],
        );
      });

      const { rows } = await db.asUser(t.ownerUserId, () =>
        db.query<{
          product_count: string;
          total_units: string;
          cost_value: string;
          retail_value: string;
        }>(`select * from stock_valuation($1, $2)`, [t.tenantId, t.branchId]),
      );

      expect(Number(rows[0]!.product_count)).toBe(1);
      expect(Number(rows[0]!.total_units)).toBe(10);
      expect(Number(rows[0]!.cost_value)).toBe(150000);
      expect(Number(rows[0]!.retail_value)).toBe(250000);
    });

    it('shows another tenant nothing', async () => {
      const a = await createTenant(db);
      const b = await createTenant(db);
      const product = await createProduct(db, b.tenantId);
      await db.asServiceRole(async () => {
        await db.query(`update products set average_cost = 99999 where id = $1`, [product]);
        await db.query(
          `insert into inventory (tenant_id, branch_id, product_id, quantity) values ($1, $2, $3, 100)`,
          [b.tenantId, b.branchId, product],
        );
      });

      const { rows } = await db.asUser(a.ownerUserId, () =>
        db.query<{ cost_value: string }>(`select * from stock_valuation($1, null)`, [b.tenantId]),
      );
      expect(Number(rows[0]!.cost_value)).toBe(0);
    });
  });

  describe('staff_sales_summary', () => {
    it('attributes sales to the cashier who made them', async () => {
      const t = await createTenant(db);
      // Real staff, not bare profiles: `profiles` RLS reveals only colleagues who share an
      // active membership, so a report naming non-members would show "Unknown" — correctly.
      const ama = await addMember(db, t.tenantId, {
        userId: await createUser(db, { fullName: 'Ama Mensah' }),
        roleKey: 'cashier',
      });
      const kofi = await addMember(db, t.tenantId, {
        userId: await createUser(db, { fullName: 'Kofi Boateng' }),
        roleKey: 'cashier',
      });

      await recordSale(t.tenantId, t.branchId, ama.userId, { number: 'S-1', total: 30000 });
      await recordSale(t.tenantId, t.branchId, ama.userId, { number: 'S-2', total: 20000 });
      await recordSale(t.tenantId, t.branchId, kofi.userId, { number: 'S-3', total: 10000 });

      const { rows } = await db.asUser(t.ownerUserId, () =>
        db.query<{ cashier_name: string; sales_count: string; gross: string }>(
          `select * from staff_sales_summary($1, now() - interval '1 day', now() + interval '1 day', $2)`,
          [t.tenantId, t.branchId],
        ),
      );

      expect(rows).toHaveLength(2);
      expect(rows[0]!.cashier_name).toBe('Ama Mensah');
      expect(Number(rows[0]!.gross)).toBe(50000);
      expect(Number(rows[1]!.gross)).toBe(10000);
    });
  });

  describe('a cashier’s view of reports', () => {
    it('shows a cashier only their own sales in an aggregate', async () => {
      // sales.view without sales.view_all restricts to your own rows, and the aggregate
      // must inherit that rather than quietly summing the branch.
      const t = await createTenant(db);
      const cashier = await addMember(db, t.tenantId, { roleKey: 'cashier' });
      const colleague = await createUser(db);

      await recordSale(t.tenantId, t.branchId, cashier.userId, { number: 'MINE', total: 10000 });
      await recordSale(t.tenantId, t.branchId, colleague, { number: 'THEIRS', total: 90000 });

      const { rows } = await db.asUser(cashier.userId, () =>
        db.query<{ gross: string }>(`select * from tenant_dashboard_today($1, $2)`, [
          t.tenantId,
          t.branchId,
        ]),
      );
      expect(Number(rows[0]!.gross)).toBe(10000);
    });
  });
});
