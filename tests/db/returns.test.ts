import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { addMember } from '../support/fixtures.js';
import { createShop, sell, type Shop } from '../support/pos.js';

/**
 * Returns, refunds and voids.
 *
 * A void cancels a sale that should never have happened. A return is a customer bringing
 * goods back, where the original sale remains part of the day's trade. Conflating them
 * erases real revenue from reporting and looks, in an audit, like a deleted transaction.
 */
describe('returns and voids', () => {
  let db: TestDatabase;
  let shop: Shop;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.reset();
    shop = await createShop(db);
  });

  async function stockOf(productId: string): Promise<number> {
    const { rows } = await db.asServiceRole(() =>
      db.query<{ q: string | null }>(
        `select quantity as q from inventory where branch_id = $1 and product_id = $2`,
        [shop.branchId, productId],
      ),
    );
    return Number(rows[0]?.q ?? 0);
  }

  async function lineOf(saleId: string) {
    const { rows } = await db.asServiceRole(() =>
      db.query<{ id: string; quantity: string; quantity_returned: string; line_total: string }>(
        `select id, quantity, quantity_returned, line_total from sale_items where sale_id = $1 order by line_number`,
        [saleId],
      ),
    );
    return rows;
  }

  async function refund(
    userId: string,
    saleId: string,
    items: { sale_item_id: string; quantity: number; condition?: string }[],
    options: { method?: string | null; reference?: string; restocked?: boolean; key?: string } = {},
  ) {
    const { rows } = await db.asUser(userId, () =>
      db.query<{ return_id: string; return_number: string; total: string; was_replayed: boolean }>(
        `select * from process_return($1, $2::jsonb, 'Customer changed their mind', $3, $4::payment_method, $5, $6, null)`,
        [
          saleId,
          JSON.stringify(items),
          options.key ?? randomUUID().replace(/-/g, ''),
          options.method === undefined ? 'CASH' : options.method,
          options.reference ?? null,
          options.restocked ?? true,
        ],
      ),
    );
    return { ...rows[0]!, total: Number(rows[0]!.total) };
  }

  describe('full return', () => {
    it('restores stock, refunds the amount charged and marks the sale returned', async () => {
      const item = await shop.stock({ price: 6500, quantity: 100, cost: 4000 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 2 }],
        payments: [{ method: 'CASH', amount: 13000 }],
      });
      expect(await stockOf(item)).toBe(98);

      const [line] = await lineOf(sale.sale_id);
      const result = await refund(shop.ownerUserId, sale.sale_id, [
        { sale_item_id: line!.id, quantity: 2 },
      ]);

      expect(result.total).toBe(13000);
      expect(result.return_number).toMatch(/^RTN-MAIN-\d{6}-0001$/);
      expect(await stockOf(item)).toBe(100);

      const { rows } = await db.asServiceRole(() =>
        db.query<{ status: string; amount_refunded: string }>(
          `select status, amount_refunded from sales where id = $1`,
          [sale.sale_id],
        ),
      );
      expect(rows[0]!.status).toBe('RETURNED');
      expect(Number(rows[0]!.amount_refunded)).toBe(13000);
    });

    it('leaves the original sale in the day’s trade', async () => {
      // A return is a separate later event, not an erasure. Voiding instead would remove
      // real revenue from the day's figures.
      const item = await shop.stock({ price: 5000, quantity: 10 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      });
      const [line] = await lineOf(sale.sale_id);
      await refund(shop.ownerUserId, sale.sale_id, [{ sale_item_id: line!.id, quantity: 1 }]);

      const { rows } = await db.asUser(shop.ownerUserId, () =>
        db.query<{ gross: string; sales_count: string }>(
          `select * from tenant_dashboard_today($1, $2)`,
          [shop.tenantId, shop.branchId],
        ),
      );
      expect(Number(rows[0]!.sales_count)).toBe(1);
      expect(Number(rows[0]!.gross)).toBe(5000);
    });
  });

  describe('partial returns', () => {
    it('composes across several returns of the same line', async () => {
      // Two back today, two more next week. Without a running total the third return
      // could exceed what was sold.
      const item = await shop.stock({ price: 1000, quantity: 100 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 5 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      });
      const [line] = await lineOf(sale.sale_id);

      const first = await refund(shop.ownerUserId, sale.sale_id, [
        { sale_item_id: line!.id, quantity: 2 },
      ]);
      expect(first.total).toBe(2000);
      expect(await stockOf(item)).toBe(97);

      const second = await refund(shop.ownerUserId, sale.sale_id, [
        { sale_item_id: line!.id, quantity: 2 },
      ]);
      expect(second.total).toBe(2000);
      expect(await stockOf(item)).toBe(99);

      const [after] = await lineOf(sale.sale_id);
      expect(Number(after!.quantity_returned)).toBe(4);

      const { rows } = await db.asServiceRole(() =>
        db.query<{ status: string; amount_refunded: string }>(
          `select status, amount_refunded from sales where id = $1`,
          [sale.sale_id],
        ),
      );
      expect(rows[0]!.status).toBe('PARTIALLY_RETURNED');
      expect(Number(rows[0]!.amount_refunded)).toBe(4000);
    });

    it('refuses to return more than was sold', async () => {
      const item = await shop.stock({ price: 1000, quantity: 100 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 3 }],
        payments: [{ method: 'CASH', amount: 3000 }],
      });
      const [line] = await lineOf(sale.sale_id);

      await expect(
        refund(shop.ownerUserId, sale.sale_id, [{ sale_item_id: line!.id, quantity: 4 }]),
      ).rejects.toThrow(/RETURN_EXCEEDS_SOLD_QUANTITY/);

      expect(await stockOf(item), 'stock moved on a refused return').toBe(97);
    });

    it('refuses to exceed the sold quantity across separate returns', async () => {
      const item = await shop.stock({ price: 1000, quantity: 100 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 3 }],
        payments: [{ method: 'CASH', amount: 3000 }],
      });
      const [line] = await lineOf(sale.sale_id);

      await refund(shop.ownerUserId, sale.sale_id, [{ sale_item_id: line!.id, quantity: 2 }]);
      await expect(
        refund(shop.ownerUserId, sale.sale_id, [{ sale_item_id: line!.id, quantity: 2 }]),
      ).rejects.toThrow(/RETURN_EXCEEDS_SOLD_QUANTITY/);
    });

    it('refunds a discounted line in proportion', async () => {
      // The customer is refunded what they paid, not the undiscounted list price.
      const item = await shop.stock({ price: 10000, quantity: 10 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 4, discount_type: 'PERCENTAGE', discount_value: 25 }],
        payments: [{ method: 'CASH', amount: 30000 }],
      });
      expect(sale.total).toBe(30000);

      const [line] = await lineOf(sale.sale_id);
      const result = await refund(shop.ownerUserId, sale.sale_id, [
        { sale_item_id: line!.id, quantity: 2 },
      ]);

      // Half the line, so half of what was actually charged for it.
      expect(result.total).toBe(15000);
    });
  });

  describe('restocking', () => {
    it('does not return damaged goods to the shelf', async () => {
      const item = await shop.stock({ price: 5000, quantity: 10 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      });
      const [line] = await lineOf(sale.sale_id);
      expect(await stockOf(item)).toBe(9);

      await refund(
        shop.ownerUserId,
        sale.sale_id,
        [{ sale_item_id: line!.id, quantity: 1, condition: 'DAMAGED' }],
        { restocked: true },
      );

      // The customer is refunded, but the item cannot be sold again.
      expect(await stockOf(item), 'damaged goods went back on the shelf').toBe(9);
    });

    it('honours a return marked as not restocked', async () => {
      const item = await shop.stock({ price: 5000, quantity: 10 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      });
      const [line] = await lineOf(sale.sale_id);

      await refund(shop.ownerUserId, sale.sale_id, [{ sale_item_id: line!.id, quantity: 1 }], {
        restocked: false,
      });
      expect(await stockOf(item)).toBe(9);
    });
  });

  describe('refund method', () => {
    it('records a return with no refund, for an exchange', async () => {
      const item = await shop.stock({ price: 5000, quantity: 10 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      });
      const [line] = await lineOf(sale.sale_id);

      await refund(shop.ownerUserId, sale.sale_id, [{ sale_item_id: line!.id, quantity: 1 }], {
        method: null,
      });

      const { rows } = await db.asServiceRole(() =>
        db.query<{ amount_refunded: string; status: string }>(
          `select amount_refunded, status from sales where id = $1`,
          [sale.sale_id],
        ),
      );
      // Goods came back and stock was restored, but no money moved.
      expect(Number(rows[0]!.amount_refunded)).toBe(0);
      expect(await stockOf(item)).toBe(10);
    });

    it('requires a reference for a mobile money refund', async () => {
      const item = await shop.stock({ price: 5000, quantity: 10 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      });
      const [line] = await lineOf(sale.sale_id);

      await expect(
        refund(shop.ownerUserId, sale.sale_id, [{ sale_item_id: line!.id, quantity: 1 }], {
          method: 'MOMO',
        }),
      ).rejects.toThrow(/PAYMENT_REFERENCE_REQUIRED/);
    });
  });

  describe('authorisation', () => {
    it('refuses a cashier without sales.refund', async () => {
      // The most common till fraud is a unilateral refund into one's own pocket.
      const item = await shop.stock({ price: 5000, quantity: 10 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      });
      const [line] = await lineOf(sale.sale_id);
      const { userId } = await addMember(db, shop.tenantId, { roleKey: 'cashier' });

      await expect(
        refund(userId, sale.sale_id, [{ sale_item_id: line!.id, quantity: 1 }]),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('allows a supervisor', async () => {
      const item = await shop.stock({ price: 5000, quantity: 10 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      });
      const [line] = await lineOf(sale.sale_id);
      const { userId } = await addMember(db, shop.tenantId, { roleKey: 'supervisor' });

      await expect(
        refund(userId, sale.sale_id, [{ sale_item_id: line!.id, quantity: 1 }]),
      ).resolves.toMatchObject({ total: 5000 });
    });

    it('refuses a line from a different sale', async () => {
      const item = await shop.stock({ price: 5000, quantity: 20 });
      const first = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      });
      const second = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      });
      const [otherLine] = await lineOf(second.sale_id);

      await expect(
        refund(shop.ownerUserId, first.sale_id, [{ sale_item_id: otherLine!.id, quantity: 1 }]),
      ).rejects.toThrow(/NOT_FOUND/);
    });

    it('refuses another tenant’s sale', async () => {
      const other = await createShop(db);
      const theirItem = await other.stock({ price: 5000, quantity: 10 });
      const theirSale = await sell(db, other.ownerUserId, other.branchId, {
        items: [{ product_id: theirItem, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      });
      const { rows } = await db.asServiceRole(() =>
        db.query<{ id: string }>(`select id from sale_items where sale_id = $1`, [
          theirSale.sale_id,
        ]),
      );

      await expect(
        refund(shop.ownerUserId, theirSale.sale_id, [{ sale_item_id: rows[0]!.id, quantity: 1 }]),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });
  });

  describe('idempotency', () => {
    it('does not refund twice on a retry', async () => {
      const item = await shop.stock({ price: 5000, quantity: 10 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 2 }],
        payments: [{ method: 'CASH', amount: 10000 }],
      });
      const [line] = await lineOf(sale.sale_id);
      const key = 'return-retry-000000000001';

      const first = await refund(
        shop.ownerUserId,
        sale.sale_id,
        [{ sale_item_id: line!.id, quantity: 1 }],
        { key },
      );
      const retry = await refund(
        shop.ownerUserId,
        sale.sale_id,
        [{ sale_item_id: line!.id, quantity: 1 }],
        { key },
      );

      expect(retry.return_id).toBe(first.return_id);
      expect(retry.was_replayed).toBe(true);

      const { rows } = await db.asServiceRole(() =>
        db.query<{ amount_refunded: string }>(`select amount_refunded from sales where id = $1`, [
          sale.sale_id,
        ]),
      );
      expect(Number(rows[0]!.amount_refunded), 'the customer was refunded twice').toBe(5000);
      expect(await stockOf(item)).toBe(9);
    });
  });

  describe('voiding', () => {
    it('reverses the sale and restores stock through the ledger', async () => {
      const item = await shop.stock({ price: 5000, quantity: 10 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 3 }],
        payments: [{ method: 'CASH', amount: 15000 }],
      });
      expect(await stockOf(item)).toBe(7);

      await db.asUser(shop.ownerUserId, () =>
        db.query(`select * from void_sale($1, 'Rung up twice')`, [sale.sale_id]),
      );

      expect(await stockOf(item)).toBe(10);

      // The reversal is posted, not erased. An append-only ledger is the whole point.
      const { rows } = await db.asServiceRole(() =>
        db.query<{ movement_type: string; quantity: string }>(
          `select movement_type, quantity from inventory_movements
           where product_id = $1 order by occurred_at, id`,
          [item],
        ),
      );
      expect(rows.map((r) => r.movement_type)).toEqual(['OPENING_STOCK', 'SALE', 'SALE_VOID']);
    });

    it('removes a voided sale from the day’s takings', async () => {
      const item = await shop.stock({ price: 5000, quantity: 10 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      });
      await db.asUser(shop.ownerUserId, () =>
        db.query(`select * from void_sale($1, 'Keyed in error')`, [sale.sale_id]),
      );

      const { rows } = await db.asUser(shop.ownerUserId, () =>
        db.query<{ gross: string; sales_count: string }>(
          `select * from tenant_dashboard_today($1, $2)`,
          [shop.tenantId, shop.branchId],
        ),
      );
      expect(Number(rows[0]!.sales_count)).toBe(0);
      expect(Number(rows[0]!.gross)).toBe(0);
    });

    it('refuses to void twice', async () => {
      const item = await shop.stock({ price: 5000, quantity: 10 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      });
      await db.asUser(shop.ownerUserId, () =>
        db.query(`select * from void_sale($1, 'First void')`, [sale.sale_id]),
      );
      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(`select * from void_sale($1, 'Second void')`, [sale.sale_id]),
        ),
      ).rejects.toThrow(/SALE_ALREADY_VOIDED/);

      expect(await stockOf(item), 'a double void restored stock twice').toBe(10);
    });

    it('refuses to void a sale that has already been partly returned', async () => {
      // The return already reversed part of it; voiding the rest would double-count the
      // stock coming back.
      const item = await shop.stock({ price: 5000, quantity: 10 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 2 }],
        payments: [{ method: 'CASH', amount: 10000 }],
      });
      const [line] = await lineOf(sale.sale_id);
      await refund(shop.ownerUserId, sale.sale_id, [{ sale_item_id: line!.id, quantity: 1 }]);

      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(`select * from void_sale($1, 'Too late')`, [sale.sale_id]),
        ),
      ).rejects.toThrow(/CONFLICT/);
    });

    it('requires a reason', async () => {
      const item = await shop.stock({ price: 5000, quantity: 10 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      });
      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(`select * from void_sale($1, '')`, [sale.sale_id]),
        ),
      ).rejects.toThrow(/VALIDATION_FAILED/);
    });

    it('refuses a supervisor without sales.void', async () => {
      const item = await shop.stock({ price: 5000, quantity: 10 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      });
      const { userId } = await addMember(db, shop.tenantId, { roleKey: 'cashier' });

      await expect(
        db.asUser(userId, () =>
          db.query(`select * from void_sale($1, 'Trying it on')`, [sale.sale_id]),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });
  });

  describe('audit trail', () => {
    it('records the return with its reason and amount', async () => {
      const item = await shop.stock({ price: 5000, quantity: 10 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      });
      const [line] = await lineOf(sale.sale_id);
      await refund(shop.ownerUserId, sale.sale_id, [{ sale_item_id: line!.id, quantity: 1 }]);

      const { rows } = await db.asServiceRole(() =>
        db.query<{ metadata: { total: number; reason: string } }>(
          `select metadata from audit_logs where action = 'SALE_REFUNDED'`,
        ),
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.metadata.total)).toBe(5000);
      expect(rows[0]!.metadata.reason).toBe('Customer changed their mind');
    });
  });
});
