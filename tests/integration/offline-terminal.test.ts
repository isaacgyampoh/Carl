import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { systemClock } from '@carl/shared';
import { SyncEngine, SyncState, SqliteSyncQueue, type SyncOutcome, type SyncTransport, type QueuedOperation } from '@carl/sync';
import { NodeSqliteConnection } from '@carl/sync/sqlite/node-sqlite-adapter';

import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { createShop, type Shop } from '../support/pos.js';

/**
 * A terminal that loses its connection, keeps selling, and comes back.
 *
 * This is the feature Carl is bought for, and it is the one that cannot be verified by
 * unit tests: it needs a real till database and a real server database at the same time,
 * with the network gone in between.
 *
 * Both halves here are the shipped code. The queue is `SqliteSyncQueue` against actual
 * SQLite, using the actual `src-tauri/schema.sql`. The server is PostgreSQL with the real
 * migrations. The engine is the one the desktop client runs.
 *
 * The one substitution is HTTP: the transport calls `sync_offline_sale` directly rather
 * than going through the Next.js route, because standing up the web server inside this
 * suite would test the framework more than it tests Carl. The route's own job — mapping
 * status codes to retry decisions — is covered by `device-api.test.ts`, and the route is
 * a thin wrapper over exactly this call.
 */
describe('a terminal that goes offline', () => {
  let db: TestDatabase;
  let shop: Shop;
  let till: NodeSqliteConnection;
  let queue: SqliteSyncQueue;
  let deviceId: string;
  let deviceSecret: string;
  let productId: string;

  const PEPPER = 'test-pepper-not-a-real-secret-value-000000';
  const TILL_SCHEMA = readFileSync(
    join(import.meta.dirname, '..', '..', 'apps', 'desktop', 'src-tauri', 'schema.sql'),
    'utf8',
  );

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  /**
   * The transport, with a switch on the wire.
   *
   * `online = false` fails the way a dead network fails: the request never reaches the
   * server. That is the property the whole test depends on — an "offline" that quietly
   * still wrote to the database would prove nothing.
   */
  function transport(options: { online?: boolean; secret?: string } = {}) {
    const state = { online: options.online ?? true, calls: 0 };

    const impl: SyncTransport & typeof state = {
      get online() {
        return state.online;
      },
      set online(value: boolean) {
        state.online = value;
      },
      get calls() {
        return state.calls;
      },
      set calls(value: number) {
        state.calls = value;
      },
      isOnline: () => state.online,
      async submit(operation: QueuedOperation): Promise<SyncOutcome> {
        if (!state.online) {
          return { kind: 'retryable', code: 'NETWORK', detail: 'The network is unreachable.' };
        }
        state.calls += 1;

        const payload = operation.payload as {
          branchId: string;
          items: unknown;
          payments: unknown;
        };

        try {
          // As the cashier, not as service_role. A sale is attributed to a person, and
          // `complete_sale` checks that person holds `sales.create` at this branch — so an
          // authorised terminal is necessary and not sufficient. Both must check out.
          const { rows } = await db.asUser(shop.ownerUserId, () =>
            db.query<{
              sale_id: string;
              was_replayed: boolean;
              had_conflict: boolean;
              conflict_id: string | null;
            }>(
              `select * from sync_offline_sale($1, $2::jsonb, $3::jsonb, $4, $5::timestamptz, $6, $7, $8)`,
              [
                payload.branchId,
                JSON.stringify(payload.items),
                JSON.stringify(payload.payments),
                operation.id,
                operation.occurredAt,
                deviceId,
                options.secret ?? deviceSecret,
                PEPPER,
              ],
            ),
          );

          const row = rows[0]!;
          if (row.had_conflict) {
            return {
              kind: 'conflict',
              conflictId: row.conflict_id,
              detail: 'Recorded, but it disagrees with the server’s stock.',
            };
          }
          return { kind: 'accepted', remoteId: row.sale_id, replayed: row.was_replayed };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/DEVICE_REVOKED|DEVICE_NOT_ACTIVATED|TENANT_SUSPENDED/.test(message)) {
            return { kind: 'unauthorized', code: 'DEVICE_REVOKED', detail: message };
          }
          return { kind: 'retryable', code: null, detail: message };
        }
      },
    };
    return impl;
  }

  function engineFor(wire: SyncTransport): SyncEngine {
    return new SyncEngine({ queue, transport: wire, clock: systemClock, maxAttempts: 3 });
  }

  /** What the cashier does: writes the sale down before saying it worked. */
  async function ring(options: { quantity: number; amount: number; at?: string }): Promise<string> {
    const id = randomUUID();
    await queue.enqueue({
      id,
      operation: 'complete_sale',
      occurredAt: options.at ?? new Date().toISOString(),
      payload: {
        branchId: shop.branchId,
        items: [{ product_id: productId, quantity: options.quantity }],
        payments: [{ method: 'CASH', amount: options.amount }],
      },
    } as never);
    return id;
  }

  const serverSales = async (): Promise<number> => {
    const { rows } = await db.asServiceRole(() =>
      db.query<{ count: string }>(`select count(*)::text as count from sales where branch_id = $1`, [
        shop.branchId,
      ]),
    );
    return Number(rows[0]!.count);
  };

  const serverStock = async (): Promise<number> => {
    const { rows } = await db.asServiceRole(() =>
      db.query<{ quantity: string }>(
        `select quantity::text as quantity from inventory where branch_id = $1 and product_id = $2`,
        [shop.branchId, productId],
      ),
    );
    return Number(rows[0]?.quantity ?? 0);
  };

  beforeEach(async () => {
    await db.reset();
    shop = await createShop(db);
    productId = await shop.stock({ name: 'Rice 5kg', price: 8000, quantity: 100 });

    // A real terminal, through the real activation flow.
    deviceId = await db.asServiceRole(async () => {
      const { rows } = await db.query<{ id: string }>(
        `insert into devices (tenant_id, branch_id, code, name) values ($1, $2, 'pos-1', 'Till 1') returning id`,
        [shop.tenantId, shop.branchId],
      );
      return rows[0]!.id;
    });
    const issued = await db.asUser(shop.ownerUserId, () =>
      db.query<{ code: string }>(`select * from issue_activation_code($1, $2, 24)`, [
        deviceId,
        PEPPER,
      ]),
    );
    const activated = await db.asServiceRole(() =>
      db.query<{ device_secret: string }>(
        `select * from activate_device($1, $2, 'install-1', 'WINDOWS', '1.0.0')`,
        [issued.rows[0]!.code, PEPPER],
      ),
    );
    deviceSecret = activated.rows[0]!.device_secret;

    // The till's own database, from the schema the shipped application ships.
    till = new NodeSqliteConnection(':memory:');
    for (const statement of TILL_SCHEMA.split(';')) {
      if (statement.trim()) await till.execute(statement);
    }
    queue = new SqliteSyncQueue(till);
    await queue.migrate();
  });

  it('sells with the connection down, and nothing reaches the server', async () => {
    const wire = transport({ online: false });

    await ring({ quantity: 2, amount: 16000 });
    await ring({ quantity: 1, amount: 8000 });
    await ring({ quantity: 3, amount: 24000 });

    await engineFor(wire).run();

    // The sales are on the till's disk.
    expect(await queue.all()).toHaveLength(3);
    // And nowhere else. An "offline" that quietly still wrote to the server would make
    // every other assertion in this file meaningless.
    expect(await serverSales()).toBe(0);
    expect(await serverStock()).toBe(100);
  });

  it('survives the terminal being killed mid-shift', async () => {
    // The property the durable queue exists for. Three sales, then the process dies —
    // no graceful shutdown, no flush.
    const path = `/tmp/carl-offline-${randomUUID()}.db`;
    const first = new NodeSqliteConnection(path);
    for (const statement of TILL_SCHEMA.split(';')) {
      if (statement.trim()) await first.execute(statement);
    }
    const before = new SqliteSyncQueue(first);
    await before.migrate();
    const saved = queue;
    queue = before;
    await ring({ quantity: 2, amount: 16000 });
    await ring({ quantity: 1, amount: 8000 });
    first.close();

    const second = new NodeSqliteConnection(path);
    const after = new SqliteSyncQueue(second);
    await after.migrate();
    queue = after;

    expect(await queue.all(), 'a shift of sales died with the process').toHaveLength(2);

    const wire = transport();
    await engineFor(wire).run();
    expect(await serverSales()).toBe(2);
    second.close();
    queue = saved;
  });

  it('sends everything once when the connection comes back', async () => {
    const wire = transport({ online: false });
    await ring({ quantity: 2, amount: 16000 });
    await ring({ quantity: 1, amount: 8000 });
    await ring({ quantity: 3, amount: 24000 });
    await engineFor(wire).run();

    wire.online = true;
    await engineFor(wire).run();

    expect(await serverSales()).toBe(3);
    expect(await serverStock()).toBe(100 - 6);

    const states = (await queue.all()).map((operation) => operation.state);
    expect(states).toEqual([SyncState.SYNCED, SyncState.SYNCED, SyncState.SYNCED]);
  });

  it('does not sell the same goods twice when the engine runs again', async () => {
    const wire = transport({ online: false });
    await ring({ quantity: 2, amount: 16000 });
    wire.online = true;
    await engineFor(wire).run();

    // A second pass — a timer firing, an operator pressing "sync now", a restart.
    await engineFor(wire).run();
    await engineFor(wire).run();

    expect(await serverSales()).toBe(1);
    expect(await serverStock()).toBe(98);
  });

  it('resends safely when the response was lost rather than the request', async () => {
    // The genuinely dangerous case: the server recorded the sale, and the terminal never
    // heard back. It cannot know whether the sale landed, so it must resend — and
    // resending must not sell the stock a second time.
    const id = await ring({ quantity: 4, amount: 32000 });

    await db.asUser(shop.ownerUserId, () =>
      db.query(
        `select * from sync_offline_sale($1, $2::jsonb, $3::jsonb, $4, now(), $5, $6, $7)`,
        [
          shop.branchId,
          JSON.stringify([{ product_id: productId, quantity: 4 }]),
          JSON.stringify([{ method: 'CASH', amount: 32000 }]),
          id,
          deviceId,
          deviceSecret,
          PEPPER,
        ],
      ),
    );
    expect(await serverSales()).toBe(1);
    expect(await serverStock()).toBe(96);

    // The till, which never got the reply, sends it again.
    await engineFor(transport()).run();

    expect(await serverSales(), 'the sale was recorded twice').toBe(1);
    expect(await serverStock(), 'the stock was sold twice').toBe(96);
    expect((await queue.get(id))?.state).toBe(SyncState.SYNCED);
  });

  it('keeps a sale that oversold the shelf, and flags it', async () => {
    // Two terminals, one shelf, no connection. Both cashiers took money and handed over
    // goods. Carl must not pretend the stock existed, and must not discard the second sale
    // — deleting the record does not un-sell the goods.
    await db.asServiceRole(() =>
      db.query(`update inventory set quantity = 5 where branch_id = $1 and product_id = $2`, [
        shop.branchId,
        productId,
      ]),
    );

    const wire = transport({ online: false });
    await ring({ quantity: 4, amount: 32000 });
    await ring({ quantity: 4, amount: 32000 });
    await engineFor(wire).run();

    wire.online = true;
    await engineFor(wire).run();

    const operations = await queue.all();
    const conflicted = operations.filter((o) => o.state === SyncState.CONFLICT);
    expect(conflicted).toHaveLength(1);

    // The first sale is recorded. The second could not be — there was no stock to sell —
    // so it is preserved as a conflict rather than as a sale.
    expect(await serverSales()).toBe(1);

    // What matters is that the second sale was not thrown away. The money was taken and
    // the goods left the shop; the record has to survive for a person to settle.
    const { rows } = await db.asServiceRole(() =>
      db.query<{ conflict_type: string; payload: { payments: { amount: number }[] } }>(
        `select conflict_type, payload from sync_conflicts where branch_id = $1`,
        [shop.branchId],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conflict_type).toBe('INSUFFICIENT_STOCK');
    // The payload is kept verbatim, so a reviewer sees what the cashier actually did.
    expect(rows[0]!.payload.payments[0]!.amount).toBe(32000);

    // And it is on somebody's list, on the till as well as the server.
    const attention = await queue.needingAttention();
    expect(attention.map((o) => o.id)).toEqual(conflicted.map((o) => o.id));
  });

  it('holds on to queued sales when the terminal is revoked', async () => {
    const wire = transport({ online: false });
    await ring({ quantity: 2, amount: 16000 });
    await ring({ quantity: 1, amount: 8000 });
    await engineFor(wire).run();

    // Reported stolen while it still holds a shift of takings.
    await db.asUser(shop.ownerUserId, () =>
      db.query(`select revoke_device($1, 'Reported stolen')`, [deviceId]),
    );

    wire.online = true;
    await engineFor(wire).run();

    // Nothing is accepted...
    expect(await serverSales()).toBe(0);
    // ...but nothing is destroyed either. The sales happened; recovering them is a
    // support question, not something a revocation should silently resolve by deletion.
    expect(await queue.all()).toHaveLength(2);
    const states = (await queue.all()).map((o) => o.state);
    expect(states).not.toContain(SyncState.SYNCED);
  });

  it('refuses a sale from a terminal presenting the wrong secret', async () => {
    // A local database is editable by whoever holds the machine. The secret is not in it,
    // and the server is what decides.
    const wire = transport({ secret: 'not-the-real-secret' });
    await ring({ quantity: 2, amount: 16000 });

    await engineFor(wire).run();

    expect(await serverSales()).toBe(0);
    expect(await serverStock()).toBe(100);
  });

  it('prices the sale from the server, not from what the till says it charged', async () => {
    // The till sends a product and a quantity. It has no field for a price, and the server
    // would ignore one if it did — an offline sale must not be a cheaper path than an
    // online one.
    const id = randomUUID();
    await queue.enqueue({
      id,
      operation: 'complete_sale',
      occurredAt: new Date().toISOString(),
      payload: {
        branchId: shop.branchId,
        items: [{ product_id: productId, quantity: 2, unit_price: 1, amount: 1, total: 1 }],
        payments: [{ method: 'CASH', amount: 16000 }],
      },
    } as never);

    await engineFor(transport()).run();

    const { rows } = await db.asServiceRole(() =>
      db.query<{ total: string }>(`select total::text as total from sales where branch_id = $1`, [
        shop.branchId,
      ]),
    );
    // 2 × GH₵80.00, from the catalogue — not the 1 pesewa the payload claimed.
    expect(rows[0]?.total).toBe('16000');
  });
});
