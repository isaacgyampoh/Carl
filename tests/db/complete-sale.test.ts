import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { addMember, createBranch } from '../support/fixtures.js';
import { createShop, grantPermission, sell, type Shop } from '../support/pos.js';

/**
 * Sale completion.
 *
 * The most important behaviour in Carl. These tests assert three things over and over,
 * because all three have to hold for the system to be worth using:
 *
 *   1. The money is right, to the pesewa.
 *   2. Stock moves exactly once, and only alongside a sale that exists.
 *   3. Nothing the client sends can change any of it.
 */
describe('complete_sale', () => {
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

  async function stockOf(productId: string, branchId = shop.branchId): Promise<number> {
    const { rows } = await db.asServiceRole(() =>
      db.query<{ q: string | null }>(
        `select quantity as q from inventory where branch_id = $1 and product_id = $2`,
        [branchId, productId],
      ),
    );
    return Number(rows[0]?.q ?? 0);
  }

  async function saleRow(saleId: string) {
    const { rows } = await db.asServiceRole(() =>
      db.query<Record<string, string>>(`select * from sales where id = $1`, [saleId]),
    );
    return rows[0]!;
  }

  describe('a straightforward sale', () => {
    it('charges the catalogue price and deducts stock', async () => {
      const rice = await shop.stock({ name: 'Rice 5kg', price: 6500, quantity: 100, cost: 4000 });

      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: rice, quantity: 2 }],
        payments: [{ method: 'CASH', amount: 13000 }],
      });

      expect(sale.total).toBe(13000);
      expect(sale.change_given).toBe(0);
      expect(sale.was_replayed).toBe(false);
      expect(await stockOf(rice)).toBe(98);

      const row = await saleRow(sale.sale_id);
      expect(Number(row.subtotal)).toBe(13000);
      expect(Number(row.cost_total)).toBe(8000);
      expect(row.status).toBe('COMPLETED');
    });

    it('writes the sale, its lines, its payments and its movements together', async () => {
      const rice = await shop.stock({ price: 6500, quantity: 10 });
      const oil = await shop.stock({ price: 2200, quantity: 10 });

      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [
          { product_id: rice, quantity: 1 },
          { product_id: oil, quantity: 3 },
        ],
        payments: [{ method: 'CASH', amount: 13100 }],
      });

      const counts = await db.asServiceRole(() =>
        db.query<{ items: number; payments: number; movements: number; audits: number }>(
          `select
             (select count(*)::int from sale_items where sale_id = $1) as items,
             (select count(*)::int from sale_payments where sale_id = $1) as payments,
             (select count(*)::int from inventory_movements where reference_id = $1) as movements,
             (select count(*)::int from audit_logs where entity_id = $1 and action = 'SALE_CREATED') as audits`,
          [sale.sale_id],
        ),
      );
      expect(counts.rows[0]).toEqual({ items: 2, payments: 1, movements: 2, audits: 1 });
      expect(sale.total).toBe(6500 + 2200 * 3);
    });

    it('numbers receipts per branch and per day', async () => {
      const rice = await shop.stock({ price: 1000, quantity: 100 });
      const kumasi = await createBranch(db, shop.tenantId, 'kumasi');
      await db.asServiceRole(() =>
        db.query(
          `insert into product_prices (tenant_id, product_id, branch_id, tier, amount)
           values ($1, $2, $3, 'RETAIL', 1000)`,
          [shop.tenantId, rice, kumasi],
        ),
      );
      await db.asUser(shop.ownerUserId, () =>
        db.query(`select * from apply_stock_adjustment($1, $2, 50, 'OPENING_STOCK', 'Stock')`, [
          kumasi,
          rice,
        ]),
      );

      const first = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: rice, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 1000 }],
      });
      const second = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: rice, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 1000 }],
      });
      const otherBranch = await sell(db, shop.ownerUserId, kumasi, {
        items: [{ product_id: rice, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 1000 }],
      });

      expect(first.sale_number).toMatch(/^MAIN-\d{6}-0001$/);
      expect(second.sale_number).toMatch(/^MAIN-\d{6}-0002$/);
      // Each branch counts for itself, so one shop's numbering does not depend on
      // another's trading volume.
      expect(otherBranch.sale_number).toMatch(/^KUMASI-\d{6}-0001$/);
    });
  });

  describe('the client cannot influence the price', () => {
    it('ignores a price sent in the payload', async () => {
      // The attack this whole design exists to defeat: intercept the checkout request and
      // change the number.
      const rice = await shop.stock({ price: 6500, quantity: 10 });

      const sale = await db.asUser(shop.ownerUserId, () =>
        db.query<{ total: string }>(
          `select total from complete_sale($1, $2::jsonb, $3::jsonb, $4)`,
          [
            shop.branchId,
            JSON.stringify([
              { product_id: rice, quantity: 1, unit_price: 1, price: 1, line_total: 1, total: 1 },
            ]),
            JSON.stringify([{ method: 'CASH', amount: 6500 }]),
            'client-price-attack-0001',
          ],
        ),
      );

      expect(Number(sale.rows[0]!.total), 'a client-supplied price was honoured').toBe(6500);
    });

    it('ignores a tenant id sent in the payload', async () => {
      const rice = await shop.stock({ price: 5000, quantity: 5 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: rice, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      });

      const row = await saleRow(sale.sale_id);
      expect(row.tenant_id).toBe(shop.tenantId);
    });

    it('refuses a product belonging to another tenant', async () => {
      const other = await createShop(db);
      const theirs = await other.stock({ price: 100, quantity: 100 });

      await expect(
        sell(db, shop.ownerUserId, shop.branchId, {
          items: [{ product_id: theirs, quantity: 1 }],
          payments: [{ method: 'CASH', amount: 100 }],
        }),
      ).rejects.toThrow(/PRODUCT_NOT_FOUND/);
    });
  });

  describe('stock', () => {
    it('refuses a sale that would oversell, and changes nothing', async () => {
      const rice = await shop.stock({ price: 1000, quantity: 3 });

      await expect(
        sell(db, shop.ownerUserId, shop.branchId, {
          items: [{ product_id: rice, quantity: 4 }],
          payments: [{ method: 'CASH', amount: 4000 }],
        }),
      ).rejects.toThrow(/INSUFFICIENT_STOCK/);

      expect(await stockOf(rice)).toBe(3);
      const { rows } = await db.asServiceRole(() => db.query(`select id from sales`));
      expect(rows, 'a refused sale left a sale row behind').toHaveLength(0);
    });

    it('rolls back every line when a later line is short', async () => {
      // The failure that would otherwise leave stock deducted with no sale to explain it.
      const plenty = await shop.stock({ name: 'Plenty', price: 1000, quantity: 100 });
      const scarce = await shop.stock({ name: 'Scarce', price: 1000, quantity: 1 });

      await expect(
        sell(db, shop.ownerUserId, shop.branchId, {
          items: [
            { product_id: plenty, quantity: 5 },
            { product_id: scarce, quantity: 10 },
          ],
          payments: [{ method: 'CASH', amount: 15000 }],
        }),
      ).rejects.toThrow(/INSUFFICIENT_STOCK/);

      expect(await stockOf(plenty), 'the first line was not rolled back').toBe(100);
      expect(await stockOf(scarce)).toBe(1);

      const movements = await db.asServiceRole(() =>
        db.query(`select id from inventory_movements where movement_type = 'SALE'`),
      );
      expect(movements.rows).toHaveLength(0);
    });

    it('sells a service without touching stock', async () => {
      const shopFixture = shop;
      const service = await shopFixture.stock({ name: 'Delivery', price: 3000 });
      await db.asServiceRole(() =>
        db.query(`update products set is_stock_tracked = false where id = $1`, [service]),
      );

      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: service, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 3000 }],
      });

      expect(sale.total).toBe(3000);
      const movements = await db.asServiceRole(() =>
        db.query(`select id from inventory_movements where product_id = $1`, [service]),
      );
      expect(movements.rows).toHaveLength(0);
    });

    it('refuses a fractional quantity of a product sold in whole units', async () => {
      const bottles = await shop.stock({ price: 500, quantity: 100, allowFractional: false });
      await expect(
        sell(db, shop.ownerUserId, shop.branchId, {
          items: [{ product_id: bottles, quantity: 0.5 }],
          payments: [{ method: 'CASH', amount: 250 }],
        }),
      ).rejects.toThrow(/INVALID_QUANTITY/);
    });

    it('sells a weighed product by fraction', async () => {
      const rice = await shop.stock({
        name: 'Loose Rice',
        price: 1000,
        quantity: 50,
        allowFractional: true,
      });

      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: rice, quantity: 1.5 }],
        payments: [{ method: 'CASH', amount: 1500 }],
      });

      expect(sale.total).toBe(1500);
      expect(await stockOf(rice)).toBe(48.5);
    });
  });

  describe('payments', () => {
    it('accepts a split across cash, mobile money and bank transfer', async () => {
      const item = await shop.stock({ price: 100000, quantity: 10 });

      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [
          { method: 'CASH', amount: 30000 },
          { method: 'MOMO', amount: 50000, reference: 'MM-8891' },
          { method: 'BANK_TRANSFER', amount: 20000, reference: 'BT-4410' },
        ],
      });

      expect(sale.total).toBe(100000);
      expect(sale.amount_paid).toBe(100000);
      expect(sale.change_given).toBe(0);

      const { rows } = await db.asServiceRole(() =>
        db.query<{ method: string; amount: string }>(
          `select method, amount from sale_payments where sale_id = $1 order by amount desc`,
          [sale.sale_id],
        ),
      );
      expect(rows.map((r) => r.method)).toEqual(['MOMO', 'CASH', 'BANK_TRANSFER']);
    });

    it('refuses a sale that is not fully paid', async () => {
      const item = await shop.stock({ price: 10000, quantity: 10 });

      await expect(
        sell(db, shop.ownerUserId, shop.branchId, {
          items: [{ product_id: item, quantity: 1 }],
          payments: [{ method: 'CASH', amount: 9999 }],
        }),
      ).rejects.toThrow(/PAYMENT_INCOMPLETE/);

      expect(await stockOf(item), 'stock moved for an unpaid sale').toBe(10);
    });

    it('computes change on an overpayment in cash', async () => {
      const item = await shop.stock({ price: 25000, quantity: 10 });

      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 30000 }],
      });

      expect(sale.total).toBe(25000);
      expect(sale.amount_paid).toBe(30000);
      expect(sale.change_given).toBe(5000);
    });

    it('refuses to give change against a non-cash overpayment', async () => {
      // Handing physical cash back for an electronic overpayment takes money out of the
      // drawer against a receipt that shows none coming in.
      const item = await shop.stock({ price: 10000, quantity: 10 });

      await expect(
        sell(db, shop.ownerUserId, shop.branchId, {
          items: [{ product_id: item, quantity: 1 }],
          payments: [{ method: 'MOMO', amount: 15000, reference: 'MM-1' }],
        }),
      ).rejects.toThrow(/CHANGE_NOT_PERMITTED/);
    });

    it('requires a reference for mobile money', async () => {
      const item = await shop.stock({ price: 5000, quantity: 10 });

      await expect(
        sell(db, shop.ownerUserId, shop.branchId, {
          items: [{ product_id: item, quantity: 1 }],
          payments: [{ method: 'MOMO', amount: 5000 }],
        }),
      ).rejects.toThrow(/PAYMENT_REFERENCE_REQUIRED/);
    });

    it('refuses a sale with no payment at all', async () => {
      const item = await shop.stock({ price: 5000, quantity: 10 });
      await expect(
        sell(db, shop.ownerUserId, shop.branchId, {
          items: [{ product_id: item, quantity: 1 }],
          payments: [],
        }),
      ).rejects.toThrow(/PAYMENT_INCOMPLETE/);
    });
  });

  describe('discounts', () => {
    it('applies a percentage discount to a line', async () => {
      const item = await shop.stock({ price: 10000, quantity: 10 });

      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1, discount_type: 'PERCENTAGE', discount_value: 10 }],
        payments: [{ method: 'CASH', amount: 9000 }],
      });

      expect(sale.total).toBe(9000);
    });

    it('rounds a discount half away from zero, matching the client', async () => {
      // GH₵9.99 less 15% is 149.85 pesewas of discount, which must round to 150 in both
      // the till's display and the database, or the two disagree by a pesewa.
      const item = await shop.stock({ price: 999, quantity: 10 });

      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1, discount_type: 'PERCENTAGE', discount_value: 15 }],
        payments: [{ method: 'CASH', amount: 849 }],
      });

      expect(sale.total).toBe(849);
    });

    it('applies an order-level discount', async () => {
      const item = await shop.stock({ price: 10000, quantity: 10 });

      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 2 }],
        payments: [{ method: 'CASH', amount: 18000 }],
        orderDiscount: { type: 'PERCENTAGE', value: 10, reason: 'Regular customer' },
      });

      expect(sale.total).toBe(18000);
    });

    it('refuses a discount from someone without the permission', async () => {
      const item = await shop.stock({ price: 10000, quantity: 10 });
      const { userId } = await addMember(db, shop.tenantId, { roleKey: 'cashier' });

      await expect(
        sell(db, userId, shop.branchId, {
          items: [
            { product_id: item, quantity: 1, discount_type: 'PERCENTAGE', discount_value: 10 },
          ],
          payments: [{ method: 'CASH', amount: 9000 }],
        }),
      ).rejects.toThrow(/DISCOUNT_NOT_PERMITTED/);
    });

    it('caps a discount for staff without the unrestricted permission', async () => {
      // Without a ceiling, "discount" is simply a way to give stock away.
      const item = await shop.stock({ price: 10000, quantity: 10 });
      const { userId } = await addMember(db, shop.tenantId, { roleKey: 'supervisor' });

      await expect(
        sell(db, userId, shop.branchId, {
          items: [
            { product_id: item, quantity: 1, discount_type: 'PERCENTAGE', discount_value: 90 },
          ],
          payments: [{ method: 'CASH', amount: 1000 }],
        }),
      ).rejects.toThrow(/DISCOUNT_EXCEEDS_LIMIT/);

      // Within the cap it goes through.
      await expect(
        sell(db, userId, shop.branchId, {
          items: [
            { product_id: item, quantity: 1, discount_type: 'PERCENTAGE', discount_value: 15 },
          ],
          payments: [{ method: 'CASH', amount: 8500 }],
        }),
      ).resolves.toMatchObject({ total: 8500 });
    });

    it('allows an unrestricted discount to a manager who holds it', async () => {
      const item = await shop.stock({ price: 10000, quantity: 10 });
      const { userId } = await addMember(db, shop.tenantId, { roleKey: 'branch_manager' });

      const sale = await sell(db, userId, shop.branchId, {
        items: [{ product_id: item, quantity: 1, discount_type: 'PERCENTAGE', discount_value: 50 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      });
      expect(sale.total).toBe(5000);
    });

    it('refuses a discount larger than the line', async () => {
      const item = await shop.stock({ price: 1000, quantity: 10 });
      await expect(
        sell(db, shop.ownerUserId, shop.branchId, {
          items: [{ product_id: item, quantity: 1, discount_type: 'AMOUNT', discount_value: 2000 }],
          payments: [{ method: 'CASH', amount: 1 }],
        }),
      ).rejects.toThrow(/INVALID_PRICE/);
    });
  });

  describe('tax', () => {
    it('extracts inclusive tax from the shelf price rather than adding to it', async () => {
      // Ghanaian retail prices normally already contain tax. Adding it at the till would
      // overcharge every customer.
      const item = await shop.stock({
        price: 11500,
        quantity: 10,
        taxMode: 'INCLUSIVE',
        taxRate: 15,
      });

      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 11500 }],
      });

      expect(sale.total).toBe(11500);

      const { rows } = await db.asServiceRole(() =>
        db.query<{ tax_amount: string }>(`select tax_amount from sale_items where sale_id = $1`, [
          sale.sale_id,
        ]),
      );
      // 11500 - (11500 / 1.15) = 1500
      expect(Number(rows[0]!.tax_amount)).toBe(1500);
    });

    it('adds exclusive tax to the price', async () => {
      const item = await shop.stock({
        price: 10000,
        quantity: 10,
        taxMode: 'EXCLUSIVE',
        taxRate: 15,
      });

      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 11500 }],
      });

      expect(sale.total).toBe(11500);
    });

    it('charges no tax on an exempt product', async () => {
      const item = await shop.stock({ price: 10000, quantity: 10, taxMode: 'EXEMPT' });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 10000 }],
      });
      expect(sale.total).toBe(10000);
    });
  });

  describe('idempotency', () => {
    it('returns the original sale when the same key arrives twice', async () => {
      // Guaranteed to happen: a lost response, or an offline terminal replaying its queue.
      const item = await shop.stock({ price: 5000, quantity: 10 });
      const key = 'retry-key-0000000000000001';

      const first = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 2 }],
        payments: [{ method: 'CASH', amount: 10000 }],
        idempotencyKey: key,
      });

      const second = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 2 }],
        payments: [{ method: 'CASH', amount: 10000 }],
        idempotencyKey: key,
      });

      expect(second.sale_id).toBe(first.sale_id);
      expect(second.sale_number).toBe(first.sale_number);
      expect(second.was_replayed, 'the retry was not reported as a replay').toBe(true);

      // The customer was charged once and stock moved once.
      expect(await stockOf(item)).toBe(8);
      const sales = await db.asServiceRole(() => db.query(`select id from sales`));
      expect(sales.rows).toHaveLength(1);
    });

    it('refuses a key reused for a different sale', async () => {
      // Otherwise a client could have a cheap sale's response returned in place of an
      // expensive one.
      const item = await shop.stock({ price: 5000, quantity: 10 });
      const key = 'reused-key-000000000000001';

      await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 5000 }],
        idempotencyKey: key,
      });

      await expect(
        sell(db, shop.ownerUserId, shop.branchId, {
          items: [{ product_id: item, quantity: 5 }],
          payments: [{ method: 'CASH', amount: 25000 }],
          idempotencyKey: key,
        }),
      ).rejects.toThrow(/IDEMPOTENCY_KEY_REUSED/);
    });

    it('lets a key be retried after a genuine failure', async () => {
      // A transient failure must not permanently burn the key and strand the terminal.
      const item = await shop.stock({ price: 5000, quantity: 1 });
      const key = 'recoverable-key-0000000001';

      await expect(
        sell(db, shop.ownerUserId, shop.branchId, {
          items: [{ product_id: item, quantity: 99 }],
          payments: [{ method: 'CASH', amount: 495000 }],
          idempotencyKey: key,
        }),
      ).rejects.toThrow(/INSUFFICIENT_STOCK/);

      await expect(
        sell(db, shop.ownerUserId, shop.branchId, {
          items: [{ product_id: item, quantity: 1 }],
          payments: [{ method: 'CASH', amount: 5000 }],
          idempotencyKey: key,
        }),
      ).resolves.toMatchObject({ total: 5000, was_replayed: false });
    });

    it('rejects a malformed key rather than proceeding without protection', async () => {
      const item = await shop.stock({ price: 1000, quantity: 10 });
      await expect(
        sell(db, shop.ownerUserId, shop.branchId, {
          items: [{ product_id: item, quantity: 1 }],
          payments: [{ method: 'CASH', amount: 1000 }],
          idempotencyKey: 'short',
        }),
      ).rejects.toThrow(/SYNC_PAYLOAD_INVALID/);
    });

    it('keeps keys separate between tenants', async () => {
      const other = await createShop(db);
      const mine = await shop.stock({ price: 1000, quantity: 10 });
      const theirs = await other.stock({ price: 2000, quantity: 10 });
      const key = 'shared-key-0000000000000001';

      const a = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: mine, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 1000 }],
        idempotencyKey: key,
      });
      const b = await sell(db, other.ownerUserId, other.branchId, {
        items: [{ product_id: theirs, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 2000 }],
        idempotencyKey: key,
      });

      expect(b.sale_id).not.toBe(a.sale_id);
      expect(b.was_replayed).toBe(false);
    });
  });

  describe('authorisation', () => {
    it('refuses a member without sales.create', async () => {
      const item = await shop.stock({ price: 1000, quantity: 10 });
      const { userId } = await addMember(db, shop.tenantId, { roleKey: 'accountant' });

      await expect(
        sell(db, userId, shop.branchId, {
          items: [{ product_id: item, quantity: 1 }],
          payments: [{ method: 'CASH', amount: 1000 }],
        }),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('refuses a branch the cashier cannot access', async () => {
      const item = await shop.stock({ price: 1000, quantity: 10 });
      const kumasi = await createBranch(db, shop.tenantId, 'kumasi');
      const { userId } = await addMember(db, shop.tenantId, {
        roleKey: 'cashier',
        branchIds: [kumasi],
      });

      await expect(
        sell(db, userId, shop.branchId, {
          items: [{ product_id: item, quantity: 1 }],
          payments: [{ method: 'CASH', amount: 1000 }],
        }),
      ).rejects.toThrow(/FORBIDDEN_BRANCH/);
    });

    it('refuses a suspended tenant', async () => {
      const item = await shop.stock({ price: 1000, quantity: 10 });
      await db.asServiceRole(() =>
        db.query(
          `update tenants set status = 'SUSPENDED', suspended_at = now(), suspension_reason = 'Non-payment' where id = $1`,
          [shop.tenantId],
        ),
      );

      await expect(
        sell(db, shop.ownerUserId, shop.branchId, {
          items: [{ product_id: item, quantity: 1 }],
          payments: [{ method: 'CASH', amount: 1000 }],
        }),
      ).rejects.toThrow(/TENANT_SUSPENDED/);
    });

    it('requires a separate permission to sell at wholesale prices', async () => {
      const item = await shop.stock({ price: 10000, quantity: 10 });
      await db.asServiceRole(() =>
        db.query(
          `insert into product_prices (tenant_id, product_id, tier, amount) values ($1, $2, 'WHOLESALE', 7000)`,
          [shop.tenantId, item],
        ),
      );
      const { userId } = await addMember(db, shop.tenantId, { roleKey: 'cashier' });

      await expect(
        sell(db, userId, shop.branchId, {
          items: [{ product_id: item, quantity: 1 }],
          payments: [{ method: 'CASH', amount: 7000 }],
          tier: 'WHOLESALE',
        }),
      ).rejects.toThrow(/PERMISSION_DENIED/);

      await grantPermission(db, shop.tenantId, 'cashier', 'sales.sell_wholesale');
      await expect(
        sell(db, userId, shop.branchId, {
          items: [{ product_id: item, quantity: 1 }],
          payments: [{ method: 'CASH', amount: 7000 }],
          tier: 'WHOLESALE',
        }),
      ).resolves.toMatchObject({ total: 7000 });
    });

    it('refuses an empty cart', async () => {
      await expect(
        sell(db, shop.ownerUserId, shop.branchId, {
          items: [],
          payments: [{ method: 'CASH', amount: 1000 }],
        }),
      ).rejects.toThrow(/EMPTY_CART/);
    });
  });

  describe('cash session', () => {
    it('attributes cash taken to the open session, net of change', async () => {
      const item = await shop.stock({ price: 25000, quantity: 10 });

      const session = await db.asServiceRole(async () => {
        const register = await db.query<{ id: string }>(
          `select id from cash_registers where branch_id = $1 limit 1`,
          [shop.branchId],
        );
        const { rows } = await db.query<{ id: string }>(
          `insert into cash_sessions (tenant_id, branch_id, register_id, opened_by, opening_float)
           values ($1, $2, $3, $4, 20000) returning id`,
          [shop.tenantId, shop.branchId, register.rows[0]!.id, shop.ownerUserId],
        );
        return rows[0]!.id;
      });

      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 30000 }],
      });
      expect(sale.change_given).toBe(5000);

      const { rows } = await db.asServiceRole(() =>
        db.query<{ cash_sales: string }>(`select cash_sales from cash_sessions where id = $1`, [
          session,
        ]),
      );
      // 30000 tendered less 5000 change is 25000 actually in the drawer.
      expect(Number(rows[0]!.cash_sales)).toBe(25000);

      const saleRecord = await saleRow(sale.sale_id);
      expect(saleRecord.cash_session_id).toBe(session);
    });
  });
});
