import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { addMember, createBranch, createProduct, createTenant } from '../support/fixtures.js';

/**
 * Price resolution.
 *
 * The server decides what things cost. A client sends a product and a quantity; nothing
 * reads a price from a request. Without that, a POS is defeated by intercepting the
 * checkout call and changing a number.
 *
 * These tests cover the resolution rules (branch override, quantity break, historical
 * lookup) and the permission boundary around changing a price — a stronger permission than
 * editing a product, because whoever holds it can sell to themselves at any price.
 */
describe('pricing', () => {
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

  async function setPrice(
    userId: string,
    productId: string,
    amount: number,
    options: { tier?: string; branchId?: string | null; minQuantity?: number } = {},
  ): Promise<void> {
    await db.asUser(userId, () =>
      db.query(`select * from set_product_price($1, $2, $3::price_tier, $4, $5)`, [
        productId,
        amount,
        options.tier ?? 'RETAIL',
        options.branchId ?? null,
        options.minQuantity ?? 0,
      ]),
    );
  }

  async function priceFor(
    userId: string,
    productId: string,
    branchId: string,
    options: { tier?: string; quantity?: number } = {},
  ): Promise<number> {
    const { rows } = await db.asUser(userId, () =>
      db.query<{ unit_price: string }>(
        `select unit_price from resolve_sale_price($1, $2, $3::price_tier, $4)`,
        [productId, branchId, options.tier ?? 'RETAIL', options.quantity ?? 1],
      ),
    );
    return Number(rows[0]!.unit_price);
  }

  describe('resolution', () => {
    it('returns the tenant-wide price when no branch override exists', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);
      await setPrice(t.ownerUserId, product, 12500);

      expect(await priceFor(t.ownerUserId, product, t.branchId)).toBe(12500);
    });

    it('prefers a branch-specific price over the tenant default', async () => {
      // A shop at an airport charges more than the one in town.
      const t = await createTenant(db);
      const airport = await createBranch(db, t.tenantId, 'airport');
      const product = await createProduct(db, t.tenantId);

      await setPrice(t.ownerUserId, product, 10000);
      await setPrice(t.ownerUserId, product, 15000, { branchId: airport });

      expect(await priceFor(t.ownerUserId, product, t.branchId)).toBe(10000);
      expect(await priceFor(t.ownerUserId, product, airport)).toBe(15000);
    });

    it('applies the highest quantity break the line qualifies for', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);

      await setPrice(t.ownerUserId, product, 1000, { tier: 'WHOLESALE', minQuantity: 0 });
      await setPrice(t.ownerUserId, product, 900, { tier: 'WHOLESALE', minQuantity: 10 });
      await setPrice(t.ownerUserId, product, 800, { tier: 'WHOLESALE', minQuantity: 100 });

      const wholesale = (quantity: number) =>
        priceFor(t.ownerUserId, product, t.branchId, { tier: 'WHOLESALE', quantity });

      expect(await wholesale(1)).toBe(1000);
      expect(await wholesale(9)).toBe(1000);
      expect(await wholesale(10)).toBe(900);
      expect(await wholesale(99)).toBe(900);
      expect(await wholesale(100)).toBe(800);
      expect(await wholesale(5000)).toBe(800);
    });

    it('keeps retail and wholesale separate', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);
      await setPrice(t.ownerUserId, product, 12000, { tier: 'RETAIL' });
      await setPrice(t.ownerUserId, product, 9000, { tier: 'WHOLESALE' });

      expect(await priceFor(t.ownerUserId, product, t.branchId, { tier: 'RETAIL' })).toBe(12000);
      expect(await priceFor(t.ownerUserId, product, t.branchId, { tier: 'WHOLESALE' })).toBe(9000);
    });

    it('reports a missing price distinctly from a missing product', async () => {
      // A product with no price is a configuration gap someone can fix; saying so saves a
      // support call that would otherwise be "the till says the product does not exist".
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);

      await expect(priceFor(t.ownerUserId, product, t.branchId)).rejects.toThrow(
        /PRICE_NOT_CONFIGURED/,
      );

      await expect(
        priceFor(t.ownerUserId, '00000000-0000-4000-8000-000000000000', t.branchId),
      ).rejects.toThrow(/PRODUCT_NOT_FOUND/);
    });

    it('refuses to price another tenant’s product', async () => {
      const a = await createTenant(db);
      const b = await createTenant(db);
      const theirs = await createProduct(db, b.tenantId);
      await setPrice(b.ownerUserId, theirs, 50000);

      await expect(priceFor(a.ownerUserId, theirs, a.branchId)).rejects.toThrow(
        /PRODUCT_NOT_FOUND/,
      );
    });
  });

  describe('price history', () => {
    it('closes the old price rather than overwriting it', async () => {
      // Windowed prices are what let a refund three months later be valued at what the
      // customer actually paid.
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);

      await setPrice(t.ownerUserId, product, 10000);
      await setPrice(t.ownerUserId, product, 12000);

      const { rows } = await db.asServiceRole(() =>
        db.query<{ amount: string; effective_to: string | null }>(
          `select amount, effective_to from product_prices where product_id = $1 order by effective_from`,
          [product],
        ),
      );

      expect(rows).toHaveLength(2);
      expect(Number(rows[0]!.amount)).toBe(10000);
      expect(rows[0]!.effective_to, 'the superseded price was not closed').not.toBeNull();
      expect(Number(rows[1]!.amount)).toBe(12000);
      expect(rows[1]!.effective_to).toBeNull();

      expect(await priceFor(t.ownerUserId, product, t.branchId)).toBe(12000);
    });

    it('resolves the price that was in force at a past moment', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);

      await db.asServiceRole(() =>
        db.query(
          `insert into product_prices (tenant_id, product_id, tier, amount, effective_from, effective_to)
           values ($1, $2, 'RETAIL', 8000, now() - interval '90 days', now() - interval '30 days'),
                  ($1, $2, 'RETAIL', 11000, now() - interval '30 days', null)`,
          [t.tenantId, product],
        ),
      );

      const historic = await db.asServiceRole(() =>
        db.query<{ price: string }>(
          `select app.resolve_price($1, $2, 'RETAIL', 1, now() - interval '60 days') as price`,
          [product, t.branchId],
        ),
      );
      expect(Number(historic.rows[0]!.price)).toBe(8000);

      const current = await db.asServiceRole(() =>
        db.query<{ price: string }>(
          `select app.resolve_price($1, $2, 'RETAIL', 1, null) as price`,
          [product, t.branchId],
        ),
      );
      expect(Number(current.rows[0]!.price)).toBe(11000);
    });

    it('survives two price changes in the same instant', async () => {
      /*
       * A regression test for a real defect, made deterministic.
       *
       * The outgoing price was closed with `effective_to = now()`. In PostgreSQL `now()` is
       * the TRANSACTION timestamp, so two price changes in one transaction closed a row at
       * the exact instant it opened, and the window constraint refused it:
       *
       *   new row for relation "product_prices" violates check constraint
       *   "product_prices_window_ordered"
       *
       * Both calls go in a single statement on purpose. Sequential calls usually land in
       * different transactions and different microseconds, which is why the original
       * property test only failed about one run in three — intermittent enough to be
       * dismissed as a glitch, which is how it would have reached a shop.
       */
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);

      await expect(
        db.asUser(t.ownerUserId, () =>
          db.query(`select set_product_price($1, 1000), set_product_price($1, 1100)`, [product]),
        ),
        'two price changes in one transaction were refused',
      ).resolves.toBeDefined();

      const { rows } = await db.asServiceRole(() =>
        db.query<{ live: number }>(
          `select count(*) filter (where effective_to is null)::int as live
             from product_prices where product_id = $1`,
          [product],
        ),
      );
      expect(rows[0]!.live).toBe(1);
    });

    it('leaves every closed window ordered', async () => {
      // A window that ends before it starts, or at the instant it starts, makes "what did
      // this cost at 14:32" ambiguous -- and the price history is what a dispute with a
      // customer is settled from.
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);
      for (const amount of [500, 600, 700, 800]) {
        await setPrice(t.ownerUserId, product, amount);
      }

      const { rows } = await db.asServiceRole(() =>
        db.query<{ bad: number }>(
          `select count(*)::int as bad from product_prices
            where product_id = $1 and effective_to is not null
              and effective_to <= effective_from`,
          [product],
        ),
      );
      expect(rows[0]!.bad, 'a price window ends at or before it starts').toBe(0);
    });

    it('never leaves two live prices for the same scope', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);

      for (const amount of [1000, 2000, 3000, 4000]) {
        await setPrice(t.ownerUserId, product, amount);
      }

      const { rows } = await db.asServiceRole(() =>
        db.query<{ n: number }>(
          `select count(*)::int as n from product_prices
           where product_id = $1 and effective_to is null`,
          [product],
        ),
      );
      expect(rows[0]!.n).toBe(1);
    });
  });

  describe('who may set a price', () => {
    it('refuses a cashier', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);
      const { userId } = await addMember(db, t.tenantId, { roleKey: 'cashier' });

      await expect(setPrice(userId, product, 1)).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('refuses an inventory manager, who may edit products but not price them', async () => {
      // The separation that stops someone who maintains the catalogue from also deciding
      // what the business charges.
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);
      const { userId } = await addMember(db, t.tenantId, { roleKey: 'inventory_manager' });

      await expect(setPrice(userId, product, 1)).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('allows a branch manager', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);
      const { userId } = await addMember(db, t.tenantId, { roleKey: 'branch_manager' });

      await expect(setPrice(userId, product, 5000)).resolves.toBeUndefined();
    });

    it('refuses a negative price', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);
      await expect(setPrice(t.ownerUserId, product, -100)).rejects.toThrow(/INVALID_PRICE/);
    });

    it('refuses a suspended tenant', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);
      await db.asServiceRole(() =>
        db.query(
          `update tenants set status = 'SUSPENDED', suspended_at = now(), suspension_reason = 'Non-payment' where id = $1`,
          [t.tenantId],
        ),
      );

      await expect(setPrice(t.ownerUserId, product, 5000)).rejects.toThrow(/TENANT_SUSPENDED/);
    });

    it('records a price change in the audit log', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);
      await setPrice(t.ownerUserId, product, 7500);

      const { rows } = await db.asServiceRole(() =>
        db.query<{ metadata: { amount: number } }>(
          `select metadata from audit_logs where action = 'PRICE_CHANGED'`,
        ),
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.metadata.amount)).toBe(7500);
    });
  });

  describe('product search', () => {
    it('returns an exact barcode match on its own', async () => {
      // A scan must be unambiguous. Making the cashier pick from a list defeats the scanner.
      const t = await createTenant(db);
      const scanned = await createProduct(db, t.tenantId, { name: 'Coca-Cola 500ml' });
      const other = await createProduct(db, t.tenantId, { name: 'Coca-Cola 1.5L' });
      await setPrice(t.ownerUserId, scanned, 500);
      await setPrice(t.ownerUserId, other, 1200);

      await db.asServiceRole(() =>
        db.query(
          `insert into product_barcodes (tenant_id, product_id, barcode) values ($1, $2, '5449000000996')`,
          [t.tenantId, scanned],
        ),
      );

      const { rows } = await db.asUser(t.ownerUserId, () =>
        db.query<{ product_id: string; is_exact: boolean; unit_price: string }>(
          `select * from search_products($1, '5449000000996', 'RETAIL', 20)`,
          [t.branchId],
        ),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]!.product_id).toBe(scanned);
      expect(rows[0]!.is_exact).toBe(true);
      expect(Number(rows[0]!.unit_price)).toBe(500);
    });

    it('multiplies a case barcode by its pack size', async () => {
      // Scanning a case of 24 should price 24 units, not one.
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId, { name: 'Water 500ml' });
      await setPrice(t.ownerUserId, product, 200, { tier: 'WHOLESALE', minQuantity: 0 });
      await setPrice(t.ownerUserId, product, 150, { tier: 'WHOLESALE', minQuantity: 24 });

      await db.asServiceRole(() =>
        db.query(
          `insert into product_barcodes (tenant_id, product_id, barcode, pack_size)
           values ($1, $2, 'CASE-24', 24)`,
          [t.tenantId, product],
        ),
      );

      const { rows } = await db.asUser(t.ownerUserId, () =>
        db.query<{ pack_size: string; unit_price: string }>(
          `select * from search_products($1, 'CASE-24', 'WHOLESALE', 20)`,
          [t.branchId],
        ),
      );

      expect(Number(rows[0]!.pack_size)).toBe(24);
      expect(Number(rows[0]!.unit_price), 'the case did not qualify for the break').toBe(150);
    });

    it('finds a product from a partial name', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId, { name: 'Coca-Cola 500ml' });
      await setPrice(t.ownerUserId, product, 500);

      const { rows } = await db.asUser(t.ownerUserId, () =>
        db.query<{ name: string }>(`select * from search_products($1, 'cola', 'RETAIL', 20)`, [
          t.branchId,
        ]),
      );
      expect(rows.map((r) => r.name)).toContain('Coca-Cola 500ml');
    });

    it('tolerates a typo, which a prefix match would not', async () => {
      // Cashiers type under queue pressure. LIKE 'coca%' cannot recover from "cocacola".
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId, { name: 'Coca Cola' });
      await setPrice(t.ownerUserId, product, 500);

      const { rows } = await db.asUser(t.ownerUserId, () =>
        db.query<{ name: string }>(`select * from search_products($1, 'cocacola', 'RETAIL', 20)`, [
          t.branchId,
        ]),
      );
      expect(rows.map((r) => r.name)).toContain('Coca Cola');
    });

    it('returns nothing for an empty query rather than the entire catalogue', async () => {
      const t = await createTenant(db);
      await createProduct(db, t.tenantId);

      const { rows } = await db.asUser(t.ownerUserId, () =>
        db.query(`select * from search_products($1, '   ', 'RETAIL', 20)`, [t.branchId]),
      );
      expect(rows).toHaveLength(0);
    });

    it('excludes inactive products', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId, { name: 'Discontinued Item' });
      await db.asServiceRole(() =>
        db.query(`update products set is_active = false where id = $1`, [product]),
      );

      const { rows } = await db.asUser(t.ownerUserId, () =>
        db.query(`select * from search_products($1, 'Discontinued', 'RETAIL', 20)`, [t.branchId]),
      );
      expect(rows).toHaveLength(0);
    });

    it('never returns another tenant’s products', async () => {
      const a = await createTenant(db);
      const b = await createTenant(db);
      const theirs = await createProduct(db, b.tenantId, { name: 'Their Secret Product' });
      await setPrice(b.ownerUserId, theirs, 999);

      const { rows } = await db.asUser(a.ownerUserId, () =>
        db.query(`select * from search_products($1, 'Secret', 'RETAIL', 20)`, [a.branchId]),
      );
      expect(rows).toHaveLength(0);
    });

    it('reports current stock alongside each result', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId, { name: 'Rice 5kg' });
      await setPrice(t.ownerUserId, product, 6500);
      await db.asUser(t.ownerUserId, () =>
        db.query(
          `select * from apply_stock_adjustment($1, $2, 42, 'OPENING_STOCK', 'Stock intake')`,
          [t.branchId, product],
        ),
      );

      const { rows } = await db.asUser(t.ownerUserId, () =>
        db.query<{ quantity: string }>(`select * from search_products($1, 'Rice', 'RETAIL', 20)`, [
          t.branchId,
        ]),
      );
      expect(Number(rows[0]!.quantity)).toBe(42);
    });
  });
});
