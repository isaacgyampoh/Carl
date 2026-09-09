import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeSqliteConnection } from '@carl/sync/sqlite/node-sqlite-adapter';

import { CatalogueStore, type CataloguePayload } from './catalogue-store';

/**
 * The local catalogue.
 *
 * Runs against the *actual* `src-tauri/schema.sql` the shipped application uses, not a
 * copy written for the test. A schema the tests invent is a schema that can drift from the
 * one on the shop floor, and the drift would only show up offline.
 */
describe('CatalogueStore', () => {
  let connection: NodeSqliteConnection;
  let store: CatalogueStore;

  const SCHEMA = readFileSync(
    join(import.meta.dirname, '..', '..', 'src-tauri', 'schema.sql'),
    'utf8',
  );

  function payload(overrides: Partial<CataloguePayload> = {}): CataloguePayload {
    return {
      server_time: '2026-03-01T09:00:00.000Z',
      tenant_id: 't1',
      branch_id: 'b1',
      products: [],
      removed_products: [],
      barcodes: [],
      prices: [],
      stock: [],
      customers: [],
      ...overrides,
    };
  }

  const product = (id: string, name: string, overrides = {}) => ({
    id,
    name,
    sku: `SKU-${id}`,
    unit: 'unit',
    allow_fractional: false,
    is_stock_tracked: true,
    tax_mode: 'INCLUSIVE',
    tax_rate: 0,
    updated_at: '2026-03-01T08:00:00.000Z',
    ...overrides,
  });

  beforeEach(async () => {
    connection = new NodeSqliteConnection(':memory:');
    for (const statement of SCHEMA.split(';')) {
      if (statement.trim()) await connection.execute(statement);
    }
    await connection.execute(
      `insert into device_config (id, device_id, tenant_id, branch_id, device_code, branch_name,
                                 tenant_name, activated_at)
       values (1, 'd1', 't1', 'b1', 'pos-1', 'Main', 'Shop', '2026-03-01T07:00:00.000Z')`,
    );
    store = new CatalogueStore(connection);
  });

  describe('applying a pull', () => {
    it('stores products, prices, stock and barcodes', async () => {
      await store.apply(
        payload({
          products: [product('p1', 'Milo Tin')],
          prices: [{ product_id: 'p1', tier: 'RETAIL', min_quantity: 0, amount: 2500 }],
          stock: [{ product_id: 'p1', quantity: 40, as_of: '2026-03-01T08:00:00.000Z' }],
          barcodes: [{ barcode: '5449000000996', product_id: 'p1', pack_size: 1 }],
        }),
      );

      const [item] = await store.search('Milo');
      expect(item?.name).toBe('Milo Tin');
      expect(item?.price).toBe(2500);
      expect(item?.stock).toBe(40);
      expect((await store.scan('5449000000996'))?.item.id).toBe('p1');
    });

    it('records the catalogue version so the next pull is incremental', async () => {
      await store.apply(payload({ server_time: '2026-03-01T09:30:00.000Z' }));
      const [config] = await connection.select<{ catalogue_version: string }>(
        'select catalogue_version from device_config where id = 1',
      );
      expect(config?.catalogue_version).toBe('2026-03-01T09:30:00.000Z');
    });

    it('removes a withdrawn product entirely', async () => {
      await store.apply({
        ...payload({ products: [product('p1', 'Discontinued')] }),
        prices: [{ product_id: 'p1', tier: 'RETAIL', min_quantity: 0, amount: 100 }],
      });
      await store.apply(payload({ removed_products: ['p1'] }));

      expect(await store.search('Discontinued')).toHaveLength(0);
      // The price rows must go with it, or a later product reusing the id inherits them.
      const prices = await connection.select('select * from product_prices where product_id = ?', [
        'p1',
      ]);
      expect(prices).toHaveLength(0);
    });

    it('drops a price the business has withdrawn rather than merging it', async () => {
      // The failure this prevents: a quantity break is cancelled centrally, the till merges
      // the new price list over the old, and goes on honouring a discount that no longer
      // exists — offline, where nobody sees it until the day is reconciled.
      await store.apply(
        payload({
          products: [product('p1', 'Rice')],
          prices: [
            { product_id: 'p1', tier: 'RETAIL', min_quantity: 0, amount: 8000 },
            { product_id: 'p1', tier: 'RETAIL', min_quantity: 10, amount: 7000 },
          ],
        }),
      );
      expect(await store.priceFor('p1', 10)).toBe(7000);

      await store.apply(
        payload({
          products: [product('p1', 'Rice')],
          prices: [{ product_id: 'p1', tier: 'RETAIL', min_quantity: 0, amount: 8000 }],
        }),
      );

      expect(await store.priceFor('p1', 10), 'a cancelled quantity break survived').toBe(8000);
    });

    it('leaves the previous catalogue intact when a pull fails halfway', async () => {
      await store.apply(
        payload({
          products: [product('p1', 'Original')],
          prices: [{ product_id: 'p1', tier: 'RETAIL', min_quantity: 0, amount: 500 }],
        }),
      );

      // A barcode referencing a product that is not in this pull violates the foreign key.
      await expect(
        store.apply(
          payload({
            products: [product('p1', 'Renamed')],
            barcodes: [{ barcode: 'X', product_id: 'does-not-exist', pack_size: 1 }],
          }),
        ),
      ).rejects.toThrow();

      // Half-applied would mean the rename stuck and the prices were gone: today's items
      // at no price at all.
      const [item] = await store.search('Original');
      expect(item?.name).toBe('Original');
      expect(item?.price).toBe(500);
    });
  });

  describe('pricing', () => {
    beforeEach(async () => {
      await store.apply(
        payload({
          products: [product('p1', 'Sugar')],
          prices: [
            { product_id: 'p1', tier: 'RETAIL', min_quantity: 0, amount: 1000 },
            { product_id: 'p1', tier: 'RETAIL', min_quantity: 12, amount: 900 },
            { product_id: 'p1', tier: 'WHOLESALE', min_quantity: 0, amount: 800 },
          ],
        }),
      );
    });

    it('applies a quantity break only at or above its threshold', async () => {
      expect(await store.priceFor('p1', 6)).toBe(1000);
      expect(await store.priceFor('p1', 11)).toBe(1000);
      expect(await store.priceFor('p1', 12)).toBe(900);
      expect(await store.priceFor('p1', 100)).toBe(900);
    });

    it('charges a wholesale customer the wholesale price', async () => {
      expect(await store.priceFor('p1', 1, 'WHOLESALE')).toBe(800);
    });

    it('falls back to retail when a tier has no price of its own', async () => {
      await store.apply(
        payload({
          products: [product('p2', 'Salt')],
          prices: [{ product_id: 'p2', tier: 'RETAIL', min_quantity: 0, amount: 300 }],
        }),
      );
      // Without the fallback the line has no price at all, and the cashier cannot sell it.
      expect(await store.priceFor('p2', 1, 'WHOLESALE')).toBe(300);
    });

    it('reports no price rather than guessing one', async () => {
      await store.apply(payload({ products: [product('p3', 'Unpriced')] }));
      expect(await store.priceFor('p3', 1)).toBeNull();
    });
  });

  describe('scanning', () => {
    it('reports the pack size so a case adds a case', async () => {
      await store.apply(
        payload({
          products: [product('p1', 'Beer')],
          prices: [{ product_id: 'p1', tier: 'RETAIL', min_quantity: 0, amount: 500 }],
          barcodes: [
            { barcode: 'SINGLE', product_id: 'p1', pack_size: 1 },
            { barcode: 'CASE24', product_id: 'p1', pack_size: 24 },
          ],
        }),
      );

      expect((await store.scan('CASE24'))?.packSize).toBe(24);
      expect((await store.scan('SINGLE'))?.packSize).toBe(1);
    });

    it('returns nothing for an unknown barcode', async () => {
      expect(await store.scan('NOT-A-BARCODE')).toBeNull();
    });

    it('tolerates the trailing whitespace a scanner appends', async () => {
      await store.apply(
        payload({
          products: [product('p1', 'Beer')],
          barcodes: [{ barcode: 'SINGLE', product_id: 'p1', pack_size: 1 }],
        }),
      );
      // Most scanners send a terminating character; a till that fails to match because of
      // it looks broken to a cashier holding the item.
      expect((await store.scan(' SINGLE\n'))?.item.id).toBe('p1');
    });
  });

  describe('stock', () => {
    it('reports when the figure was last confirmed', async () => {
      // A stock number of unknown age presented as current is worse than one labelled stale.
      await store.apply(
        payload({
          products: [product('p1', 'Bread')],
          stock: [{ product_id: 'p1', quantity: 3, as_of: '2026-03-01T06:00:00.000Z' }],
        }),
      );
      const [item] = await store.search('Bread');
      expect(item?.stockAsOf).toBe('2026-03-01T06:00:00.000Z');
    });

    it('reports zero for a product the branch has never stocked', async () => {
      await store.apply(payload({ products: [product('p1', 'Never Stocked')] }));
      const [item] = await store.search('Never');
      expect(item?.stock).toBe(0);
    });
  });
});
