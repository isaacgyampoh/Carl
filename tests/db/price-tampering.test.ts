import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { createShop, type Shop } from '../support/pos.js';

/**
 * Attacking the checkout.
 *
 * Carl's central claim is that the client cannot influence what a customer is charged. The
 * client sends a product and a quantity; the server decides the rest. These tests attack
 * that claim from every angle a modified client could.
 *
 * Each case asserts one of two acceptable outcomes:
 *
 *   - the sale is REFUSED with a specific error, or
 *   - the sale completes at the CORRECT price, the injected value having been ignored
 *
 * What is never acceptable is a sale completing at a price the attacker chose, or stock
 * moving in a way the ledger cannot account for.
 */
describe('price and payload tampering', () => {
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

  /** Submits a raw items payload, bypassing the typed helper entirely. */
  async function rawSale(items: unknown[], payments: unknown[], key: string) {
    return db.asUser(shop.ownerUserId, () =>
      db.query<{ total: string; sale_id: string }>(
        `select sale_id, total from complete_sale($1, $2::jsonb, $3::jsonb, $4)`,
        [shop.branchId, JSON.stringify(items), JSON.stringify(payments), key],
      ),
    );
  }

  async function stockOf(productId: string): Promise<number> {
    const { rows } = await db.asServiceRole(() =>
      db.query<{ q: string | null }>(
        `select quantity as q from inventory where branch_id = $1 and product_id = $2`,
        [shop.branchId, productId],
      ),
    );
    return Number(rows[0]?.q ?? 0);
  }

  describe('injected prices are ignored', () => {
    it('ignores every price-shaped field a client could invent', async () => {
      const item = await shop.stock({ price: 6500, quantity: 10 });

      const { rows } = await rawSale(
        [
          {
            product_id: item,
            quantity: 1,
            // Every name a naive implementation might read.
            unit_price: 1,
            price: 1,
            amount: 1,
            line_total: 1,
            total: 1,
            subtotal: 1,
            cost: 1,
            unit_cost: 1,
            tax_amount: 0,
            retail_price: 1,
          },
        ],
        [{ method: 'CASH', amount: 6500 }],
        'tamper-price-fields-0001',
      );

      expect(Number(rows[0]!.total), 'an injected price was honoured').toBe(6500);
    });

    it('ignores an injected order total', async () => {
      const item = await shop.stock({ price: 10000, quantity: 10 });
      const { rows } = await rawSale(
        [{ product_id: item, quantity: 2, total: 1, subtotal: 1 }],
        [{ method: 'CASH', amount: 20000 }],
        'tamper-order-total-00001',
      );
      expect(Number(rows[0]!.total)).toBe(20000);
    });

    it('ignores an injected tax amount', async () => {
      const item = await shop.stock({
        price: 11500,
        quantity: 10,
        taxMode: 'INCLUSIVE',
        taxRate: 15,
      });
      const { rows } = await rawSale(
        [{ product_id: item, quantity: 1, tax_amount: 999999, tax_rate: 0 }],
        [{ method: 'CASH', amount: 11500 }],
        'tamper-tax-00000000001',
      );
      expect(Number(rows[0]!.total)).toBe(11500);

      const tax = await db.asServiceRole(() =>
        db.query<{ tax_amount: string }>(`select tax_amount from sale_items where sale_id = $1`, [
          rows[0]!.sale_id,
        ]),
      );
      expect(Number(tax.rows[0]!.tax_amount)).toBe(1500);
    });
  });

  describe('quantity attacks', () => {
    it('refuses a negative quantity', async () => {
      // Would otherwise be a credit: negative quantity, negative line, money out.
      const item = await shop.stock({ price: 1000, quantity: 10 });
      await expect(
        rawSale(
          [{ product_id: item, quantity: -5 }],
          [{ method: 'CASH', amount: 1 }],
          'tamper-neg-qty-0000001',
        ),
      ).rejects.toThrow(/INVALID_QUANTITY/);
      expect(await stockOf(item)).toBe(10);
    });

    it('refuses a zero quantity', async () => {
      const item = await shop.stock({ price: 1000, quantity: 10 });
      await expect(
        rawSale(
          [{ product_id: item, quantity: 0 }],
          [{ method: 'CASH', amount: 1 }],
          'tamper-zero-qty-000001',
        ),
      ).rejects.toThrow(/INVALID_QUANTITY/);
    });

    it('refuses an implausibly large quantity, on stock rather than overflow', async () => {
      const item = await shop.stock({ price: 1000, quantity: 10 });
      await expect(
        rawSale(
          [{ product_id: item, quantity: 1_000_000_000 }],
          [{ method: 'CASH', amount: 1 }],
          'tamper-huge-qty-000001',
        ),
      ).rejects.toThrow(/INSUFFICIENT_STOCK|INVALID_QUANTITY|out of range|overflow/i);
      expect(await stockOf(item)).toBe(10);
    });

    it('refuses a non-numeric quantity', async () => {
      const item = await shop.stock({ price: 1000, quantity: 10 });
      await expect(
        rawSale(
          [{ product_id: item, quantity: 'many' }],
          [{ method: 'CASH', amount: 1 }],
          'tamper-nan-qty-0000001',
        ),
      ).rejects.toThrow();
      expect(await stockOf(item)).toBe(10);
    });
  });

  describe('discount attacks', () => {
    it('refuses a negative discount, which would inflate the charge', async () => {
      // Without a guard this charges MORE than the catalogue price: net = gross − (−x).
      // A CHECK on sale_items catches it as a last resort, but a raw constraint violation
      // is not something a cashier can act on, so it is refused explicitly first.
      const item = await shop.stock({ price: 10000, quantity: 10 });

      await expect(
        rawSale(
          [{ product_id: item, quantity: 1, discount_type: 'AMOUNT', discount_value: -50000 }],
          [{ method: 'CASH', amount: 10000 }],
          'tamper-neg-discount-001',
        ),
      ).rejects.toThrow(/INVALID_PRICE/);

      expect(await stockOf(item), 'stock moved for a refused sale').toBe(10);
    });

    it('refuses a negative order-level discount', async () => {
      const item = await shop.stock({ price: 10000, quantity: 10 });
      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(
            `select * from complete_sale($1, $2::jsonb, $3::jsonb, $4, null, 'RETAIL',
                                          null, null, null, 'AMOUNT'::discount_type, -99999)`,
            [
              shop.branchId,
              JSON.stringify([{ product_id: item, quantity: 1 }]),
              JSON.stringify([{ method: 'CASH', amount: 10000 }]),
              'tamper-neg-order-disc-1',
            ],
          ),
        ),
      ).rejects.toThrow(/INVALID_PRICE/);
    });

    it('refuses a discount larger than the line', async () => {
      const item = await shop.stock({ price: 1000, quantity: 10 });
      await expect(
        rawSale(
          [{ product_id: item, quantity: 1, discount_type: 'AMOUNT', discount_value: 99999 }],
          [{ method: 'CASH', amount: 1 }],
          'tamper-huge-discount-01',
        ),
      ).rejects.toThrow(/INVALID_PRICE|DISCOUNT/);
    });

    it('refuses a percentage discount above 100', async () => {
      const item = await shop.stock({ price: 10000, quantity: 10 });
      await expect(
        rawSale(
          [{ product_id: item, quantity: 1, discount_type: 'PERCENTAGE', discount_value: 500 }],
          [{ method: 'CASH', amount: 1 }],
          'tamper-pct-over-100-01',
        ),
      ).rejects.toThrow(/INVALID_PRICE|DISCOUNT/);
    });
  });

  describe('payment attacks', () => {
    it('refuses a negative payment', async () => {
      // Two payments summing to the total, one of them negative, would take cash out.
      const item = await shop.stock({ price: 10000, quantity: 10 });
      await expect(
        rawSale(
          [{ product_id: item, quantity: 1 }],
          [
            { method: 'CASH', amount: 20000 },
            { method: 'CASH', amount: -10000 },
          ],
          'tamper-neg-payment-001',
        ),
      ).rejects.toThrow(/PAYMENT_INCOMPLETE|amount_positive/);
    });

    it('refuses a zero payment', async () => {
      const item = await shop.stock({ price: 10000, quantity: 10 });
      await expect(
        rawSale(
          [{ product_id: item, quantity: 1 }],
          [{ method: 'CASH', amount: 0 }],
          'tamper-zero-payment-01',
        ),
      ).rejects.toThrow(/PAYMENT_INCOMPLETE/);
    });

    it('refuses an unknown payment method', async () => {
      const item = await shop.stock({ price: 1000, quantity: 10 });
      await expect(
        rawSale(
          [{ product_id: item, quantity: 1 }],
          [{ method: 'BITCOIN', amount: 1000 }],
          'tamper-bad-method-0001',
        ),
      ).rejects.toThrow();
    });
  });

  describe('product attacks', () => {
    it('refuses an unknown product', async () => {
      await expect(
        rawSale(
          [{ product_id: '00000000-0000-4000-8000-000000000000', quantity: 1 }],
          [{ method: 'CASH', amount: 1000 }],
          'tamper-unknown-prod-01',
        ),
      ).rejects.toThrow(/PRODUCT_NOT_FOUND/);
    });

    it('refuses an inactive product', async () => {
      const item = await shop.stock({ price: 1000, quantity: 10 });
      await db.asServiceRole(() =>
        db.query(`update products set is_active = false where id = $1`, [item]),
      );

      await expect(
        rawSale(
          [{ product_id: item, quantity: 1 }],
          [{ method: 'CASH', amount: 1000 }],
          'tamper-inactive-000001',
        ),
      ).rejects.toThrow(/PRODUCT_INACTIVE/);
    });

    it('refuses another tenant’s product', async () => {
      const other = await createShop(db);
      const theirs = await other.stock({ price: 100, quantity: 100 });

      await expect(
        rawSale(
          [{ product_id: theirs, quantity: 1 }],
          [{ method: 'CASH', amount: 100 }],
          'tamper-wrong-tenant-01',
        ),
      ).rejects.toThrow(/PRODUCT_NOT_FOUND/);
    });

    it('refuses a product with no price configured', async () => {
      // Distinct from "not found": a configuration gap someone can fix.
      const { rows } = await db.asUser(shop.ownerUserId, () =>
        db.query<{ product_id: string }>(
          `select * from upsert_product($1, 'Unpriced', 'UNPRICED-1', 0)`,
          [shop.branchId],
        ),
      );
      await db.asServiceRole(() =>
        db.query(`delete from product_prices where product_id = $1`, [rows[0]!.product_id]),
      );

      await expect(
        rawSale(
          [{ product_id: rows[0]!.product_id, quantity: 1 }],
          [{ method: 'CASH', amount: 100 }],
          'tamper-no-price-000001',
        ),
      ).rejects.toThrow(/PRICE_NOT_CONFIGURED/);
    });
  });

  describe('branch attacks', () => {
    it('refuses a branch the caller cannot access', async () => {
      const other = await createShop(db);
      const item = await shop.stock({ price: 1000, quantity: 10 });

      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(`select * from complete_sale($1, $2::jsonb, $3::jsonb, $4)`, [
            other.branchId,
            JSON.stringify([{ product_id: item, quantity: 1 }]),
            JSON.stringify([{ method: 'CASH', amount: 1000 }]),
            'tamper-wrong-branch-01',
          ]),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED|FORBIDDEN_BRANCH/);
    });
  });

  describe('nothing is left behind', () => {
    it('leaves no sale, no stock movement and no payment after any refused attempt', async () => {
      // The property that matters most: a refused attack must be a complete no-op.
      const item = await shop.stock({ price: 1000, quantity: 10 });

      const attacks: [unknown[], unknown[], string][] = [
        [
          [{ product_id: item, quantity: -1 }],
          [{ method: 'CASH', amount: 1 }],
          'noop-a-0000000000001',
        ],
        [
          [{ product_id: item, quantity: 999999 }],
          [{ method: 'CASH', amount: 1 }],
          'noop-b-0000000000001',
        ],
        [
          [{ product_id: item, quantity: 1 }],
          [{ method: 'CASH', amount: 1 }],
          'noop-c-0000000000001',
        ],
        [[{ product_id: item, quantity: 1 }], [], 'noop-d-0000000000001'],
      ];

      for (const [items, payments, key] of attacks) {
        await rawSale(items, payments, key).catch(() => undefined);
      }

      const state = await db.asServiceRole(() =>
        db.query<{ sales: number; items: number; payments: number; movements: number }>(
          `select
             (select count(*)::int from sales) as sales,
             (select count(*)::int from sale_items) as items,
             (select count(*)::int from sale_payments) as payments,
             (select count(*)::int from inventory_movements where movement_type = 'SALE') as movements`,
        ),
      );

      expect(state.rows[0], 'a refused attack left rows behind').toEqual({
        sales: 0,
        items: 0,
        payments: 0,
        movements: 0,
      });
      expect(await stockOf(item)).toBe(10);
    });
  });
});
