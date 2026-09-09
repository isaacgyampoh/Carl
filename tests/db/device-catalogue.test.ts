import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { createShop, type Shop } from '../support/pos.js';

/**
 * The catalogue a terminal downloads in order to sell offline.
 *
 * A till is physically exposed in a way a server is not: it sits on a counter, it gets
 * stolen, and its disk can be read at leisure. So what it is allowed to download is a
 * security boundary, and the interesting assertions here are all about what is *absent*.
 */
describe('device catalogue', () => {
  let db: TestDatabase;
  let shop: Shop;
  let deviceId: string;
  let deviceSecret: string;

  const PEPPER = 'test-pepper-not-a-real-secret-value-000000';

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  /** Activates a terminal through the real activation flow. */
  async function activate(branchId: string, code: string): Promise<{ id: string; secret: string }> {
    const id = await db.asServiceRole(async () => {
      const { rows } = await db.query<{ id: string }>(
        `insert into devices (tenant_id, branch_id, code, name) values ($1, $2, $3, $4) returning id`,
        [shop.tenantId, branchId, code, `Till ${code}`],
      );
      return rows[0]!.id;
    });

    const issued = await db.asUser(shop.ownerUserId, () =>
      db.query<{ code: string }>(`select * from issue_activation_code($1, $2, 24)`, [id, PEPPER]),
    );
    const activated = await db.asServiceRole(() =>
      db.query<{ device_secret: string }>(
        `select * from activate_device($1, $2, $3, 'WINDOWS', '1.0.0')`,
        [issued.rows[0]!.code, PEPPER, `install-${code}`],
      ),
    );
    return { id, secret: activated.rows[0]!.device_secret };
  }

  interface Catalogue {
    server_time: string;
    tenant_id: string;
    branch_id: string;
    products: { id: string; name: string; sku: string; updated_at: string }[];
    removed_products: string[];
    barcodes: { barcode: string; product_id: string; pack_size: number }[];
    prices: { product_id: string; tier: string; min_quantity: number; amount: number }[];
    stock: { product_id: string; quantity: number; as_of: string }[];
    customers: { id: string; name: string; phone: string | null; default_tier: string }[];
  }

  async function pull(
    since: string | null = null,
    secret = deviceSecret,
    device = deviceId,
  ): Promise<Catalogue> {
    const { rows } = await db.asServiceRole(() =>
      db.query<{ device_catalogue: Catalogue }>(`select device_catalogue($1, $2, $3, $4)`, [
        device,
        secret,
        PEPPER,
        since,
      ]),
    );
    return rows[0]!.device_catalogue;
  }

  beforeEach(async () => {
    await db.reset();
    shop = await createShop(db);
    const device = await activate(shop.branchId, 'pos-1');
    deviceId = device.id;
    deviceSecret = device.secret;
  });

  describe('authorisation', () => {
    it('refuses a terminal that presents the wrong secret', async () => {
      await expect(pull(null, 'not-the-secret')).rejects.toThrow(/DEVICE_NOT_ACTIVATED/);
    });

    it('refuses a revoked terminal', async () => {
      // The property that makes revocation worth anything: a stolen till stops being able
      // to pull the catalogue the moment it is reported.
      await db.asUser(shop.ownerUserId, () =>
        db.query(`select revoke_device($1, 'Stolen from the counter')`, [deviceId]),
      );
      await expect(pull()).rejects.toThrow(/DEVICE_REVOKED/);
    });

    it('is not reachable by an ordinary signed-in user', async () => {
      // The pepper is an argument, so this function must never be callable by anyone who
      // could supply a guess for it.
      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(`select device_catalogue($1, $2, $3, null)`, [deviceId, deviceSecret, PEPPER]),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it('is not reachable anonymously', async () => {
      await expect(
        db.asAnon(() =>
          db.query(`select device_catalogue($1, $2, $3, null)`, [deviceId, deviceSecret, PEPPER]),
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe('what it contains', () => {
    it('carries the products, prices, stock and barcodes needed to ring up a sale', async () => {
      const productId = await shop.stock({ name: 'Milo Tin', price: 2500, quantity: 40 });
      await db.asServiceRole(() =>
        db.query(
          `insert into product_barcodes (tenant_id, product_id, barcode, pack_size) values ($1, $2, '5449000000996', 1)`,
          [shop.tenantId, productId],
        ),
      );

      const catalogue = await pull();

      expect(catalogue.products.map((p) => p.name)).toContain('Milo Tin');
      expect(catalogue.prices).toContainEqual(
        expect.objectContaining({ product_id: productId, tier: 'RETAIL', amount: 2500 }),
      );
      expect(catalogue.stock).toContainEqual(
        expect.objectContaining({ product_id: productId, quantity: 40 }),
      );
      expect(catalogue.barcodes).toContainEqual(
        expect.objectContaining({ barcode: '5449000000996', product_id: productId }),
      );
    });

    it('resolves a branch price override in favour of the branch', async () => {
      // The airport shop charges more. Resolving it here means one implementation of the
      // rule, in the same place that charges for the sale.
      const productId = await shop.stock({ name: 'Water', price: 200, quantity: 10 });
      await db.asServiceRole(() =>
        db.query(
          `insert into product_prices (tenant_id, product_id, branch_id, tier, amount)
           values ($1, $2, $3, 'RETAIL', 500)`,
          [shop.tenantId, productId, shop.branchId],
        ),
      );

      const retail = (await pull()).prices.filter(
        (p) => p.product_id === productId && p.tier === 'RETAIL',
      );

      expect(retail).toHaveLength(1);
      expect(retail[0]!.amount, 'the terminal would undercharge at this branch').toBe(500);
    });

    it('carries customers without their financial standing', async () => {
      await db.asServiceRole(() =>
        db.query(
          `insert into customers (tenant_id, name, phone, default_tier, balance, credit_limit)
           values ($1, 'Ama Mensah', '0244000111', 'WHOLESALE', 450000, 900000)`,
          [shop.tenantId],
        ),
      );

      const customer = (await pull()).customers.find((c) => c.name === 'Ama Mensah');

      expect(customer).toBeDefined();
      expect(customer!.default_tier).toBe('WHOLESALE');
      // A debt list is not needed to ring up a sale.
      expect(Object.keys(customer!)).toEqual(['id', 'name', 'phone', 'default_tier']);
    });
  });

  describe('what it must never contain', () => {
    it('does not reveal what the business pays its suppliers', async () => {
      await shop.stock({ name: 'Rice 5kg', price: 8000, quantity: 20, cost: 5500 });

      const catalogue = await pull();
      const serialised = JSON.stringify(catalogue);

      for (const key of ['average_cost', 'last_cost', 'cost']) {
        expect(serialised, `the catalogue leaked ${key}`).not.toContain(key);
      }
      // The cost itself, not just its label.
      expect(serialised).not.toContain('5500');
    });

    it('does not carry another branch of the same business', async () => {
      const otherBranch = await db.asServiceRole(async () => {
        const { rows } = await db.query<{ id: string }>(
          `insert into branches (tenant_id, code, name) values ($1, 'airport', 'Airport') returning id`,
          [shop.tenantId],
        );
        return rows[0]!.id;
      });
      const productId = await shop.stock({ name: 'Shared Product', price: 1000, quantity: 5 });

      // Stock the same product at the other branch, at a distinctive quantity.
      await db.asServiceRole(() =>
        db.query(
          `insert into inventory (tenant_id, branch_id, product_id, quantity) values ($1, $2, $3, 999)`,
          [shop.tenantId, otherBranch, productId],
        ),
      );

      const stock = (await pull()).stock.filter((s) => s.product_id === productId);

      expect(stock).toHaveLength(1);
      expect(stock[0]!.quantity, "the till was shown another branch's stock").toBe(5);
    });

    it('does not carry another business', async () => {
      const other = await createShop(db);
      await other.stock({ name: 'Rival Secret Product', price: 100, quantity: 1 });

      const catalogue = await pull();

      expect(JSON.stringify(catalogue)).not.toContain('Rival Secret Product');
      expect(catalogue.tenant_id).toBe(shop.tenantId);
    });

    it('does not carry sales, staff, suppliers or purchases', async () => {
      // The local schema stores none of these by design: a stolen terminal should yield a
      // catalogue, not a business. This asserts the server agrees.
      const catalogue = await pull();
      expect(Object.keys(catalogue).sort()).toEqual([
        'barcodes',
        'branch_id',
        'customers',
        'prices',
        'products',
        'removed_products',
        'server_time',
        'stock',
        'tenant_id',
      ]);
    });
  });

  describe('incremental download', () => {
    it('returns only what changed', async () => {
      await shop.stock({ name: 'Before The Sync', price: 100, quantity: 1 });
      const first = await pull();

      await shop.stock({ name: 'After The Sync', price: 200, quantity: 2 });
      const second = await pull(first.server_time);

      const names = second.products.map((p) => p.name);
      expect(names).toContain('After The Sync');
      expect(names).not.toContain('Before The Sync');
    });

    it('tells a terminal which products to forget', async () => {
      // Without this a till only ever accumulates, and would go on selling something the
      // business has withdrawn.
      const productId = await shop.stock({ name: 'Discontinued', price: 100, quantity: 1 });
      const first = await pull();
      expect(first.products.map((p) => p.id)).toContain(productId);

      await db.asServiceRole(() =>
        db.query(`update products set is_active = false, updated_at = now() where id = $1`, [
          productId,
        ]),
      );

      const second = await pull(first.server_time);
      expect(second.removed_products).toContain(productId);
      expect(second.products.map((p) => p.id)).not.toContain(productId);
    });

    it('stamps the cursor with the server clock, not the terminal', async () => {
      // A till with a wrong clock must not be able to talk itself out of an update.
      const before = new Date();
      const catalogue = await pull();
      const stamped = new Date(catalogue.server_time);
      expect(Math.abs(stamped.getTime() - before.getTime())).toBeLessThan(120_000);
    });
  });
});
