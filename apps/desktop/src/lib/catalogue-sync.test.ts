import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeSqliteConnection } from '@carl/sync/sqlite/node-sqlite-adapter';

import { CatalogueStore } from './catalogue-store';
import { CatalogueSync } from './catalogue-sync';
import { DeviceApi } from './device-api';
import { DeviceStore } from './device-store';

/**
 * Keeping the catalogue current.
 *
 * The behaviour worth pinning is what happens when it *cannot* be kept current, because
 * that is the state a shop with bad internet spends its afternoon in: the till must go on
 * selling yesterday's list rather than failing, and it must not record that it is up to
 * date when it is not.
 */
describe('CatalogueSync', () => {
  let connection: NodeSqliteConnection;
  let devices: DeviceStore;
  let store: CatalogueStore;

  const SCHEMA = readFileSync(
    join(import.meta.dirname, '..', '..', 'src-tauri', 'schema.sql'),
    'utf8',
  );
  const credential = { deviceId: 'd1', deviceSecret: 'x'.repeat(64) };

  function payload(overrides: Record<string, unknown> = {}) {
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

  const product = (id: string, name: string) => ({
    id,
    name,
    sku: `SKU-${id}`,
    unit: 'unit',
    allow_fractional: false,
    is_stock_tracked: true,
    tax_mode: 'INCLUSIVE',
    tax_rate: 0,
    updated_at: '2026-03-01T08:00:00.000Z',
  });

  /** A fetch returning one prepared catalogue response, recording what was asked for. */
  function server(body: unknown, status = 200) {
    const calls: unknown[] = [];
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      // Narrowed rather than stringified: a non-string body must fail the test loudly
      // rather than being recorded as "[object Object]".
      calls.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    return { calls, fetchImpl: fetchImpl as unknown as typeof globalThis.fetch };
  }

  function syncWith(fetchImpl: typeof globalThis.fetch): CatalogueSync {
    return new CatalogueSync(
      new DeviceApi({ baseUrl: 'https://carl.example', fetch: fetchImpl }),
      store,
      devices,
      credential,
    );
  }

  beforeEach(async () => {
    connection = new NodeSqliteConnection(':memory:');
    for (const statement of SCHEMA.split(';')) {
      if (statement.trim()) await connection.execute(statement);
    }
    devices = new DeviceStore(connection);
    store = new CatalogueStore(connection);
    await devices.save({
      deviceId: 'd1',
      tenantId: 't1',
      branchId: 'b1',
      deviceCode: 'pos-1',
      branchName: 'Main',
      tenantName: 'Shop',
      authorizedUntil: '2026-03-02T09:00:00.000Z',
      lastSyncAt: null,
      catalogueVersion: null,
      activatedAt: '2026-03-01T07:00:00.000Z',
    });
  });

  it('downloads everything on first run', async () => {
    const { calls, fetchImpl } = server(payload({ products: [product('p1', 'Rice')] }));

    const result = await syncWith(fetchImpl).run();

    expect(result.ok).toBe(true);
    // No cursor yet, so the server is asked for everything.
    expect((calls[0] as { since: string | null }).since).toBeNull();
    expect(await store.search('Rice')).toHaveLength(1);
  });

  it('asks only for what changed on the next run', async () => {
    await syncWith(server(payload({ server_time: '2026-03-01T09:00:00.000Z' })).fetchImpl).run();

    const { calls, fetchImpl } = server(payload({ server_time: '2026-03-01T10:00:00.000Z' }));
    await syncWith(fetchImpl).run();

    // The cursor is the server's time from the previous pull, never this machine's clock.
    expect((calls[0] as { since: string }).since).toBe('2026-03-01T09:00:00.000Z');
  });

  it('re-downloads everything when asked for a full refresh', async () => {
    await syncWith(server(payload()).fetchImpl).run();

    const { calls, fetchImpl } = server(payload());
    await syncWith(fetchImpl).run({ full: true });

    expect((calls[0] as { since: string | null }).since).toBeNull();
  });

  it('corrects the terminal clock from the server time', async () => {
    // A till a day out would stamp offline sales into the wrong day, and the server
    // refuses a sale dated in the future — so a fast clock loses sales outright.
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await syncWith(server(payload({ server_time: future })).fetchImpl).run();

    const config = await devices.read();
    expect(Math.abs((config?.clockOffsetMs ?? 0) - 3_600_000)).toBeLessThan(5_000);
  });

  describe('when the catalogue cannot be refreshed', () => {
    it('reports failure without throwing', async () => {
      const { fetchImpl } = server({ error: 'INTERNAL', detail: 'boom', retryable: true }, 500);

      const result = await syncWith(fetchImpl).run();

      expect(result.ok).toBe(false);
    });

    it('leaves the existing catalogue in place', async () => {
      await syncWith(server(payload({ products: [product('p1', 'Rice')] })).fetchImpl).run();

      const { fetchImpl } = server({ error: 'NETWORK', detail: 'down', retryable: true }, 500);
      await syncWith(fetchImpl).run();

      // The till goes on selling yesterday's list. That is what it is for.
      expect(await store.search('Rice')).toHaveLength(1);
    });

    it('does not advance the cursor', async () => {
      await syncWith(server(payload({ server_time: '2026-03-01T09:00:00.000Z' })).fetchImpl).run();

      const { fetchImpl } = server({ error: 'NETWORK', detail: 'down', retryable: true }, 500);
      await syncWith(fetchImpl).run();

      // Advancing on a failure would make the terminal skip everything that changed in
      // between, permanently, and it would never know.
      const config = await devices.read();
      expect(config?.catalogueVersion).toBe('2026-03-01T09:00:00.000Z');
    });
  });
});
