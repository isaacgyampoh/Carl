import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { createShop, sell, type Shop } from '../support/pos.js';

/**
 * Genuine concurrency, against real PostgreSQL.
 *
 * ## Why this file is separate
 *
 * A real race needs two sessions against one server. The default in-process harness
 * (PGlite) is an embedded single-connection engine and cannot provide that, so these tests
 * skip there rather than pass vacuously — a concurrency test that cannot fail is worse than
 * no concurrency test, because it implies coverage that does not exist.
 *
 * Run with:
 *   CARL_TEST_DB_DRIVER=pg CARL_ALLOW_DESTRUCTIVE_DB_TESTS=yes pnpm test:db
 *
 * ## What is actually being proved
 *
 * `app.apply_movement` takes `FOR UPDATE` on the inventory row before reading its quantity.
 * Without that lock, two tills both read "10 available", both decide their sale is fine,
 * and both commit — selling fifteen units from a shelf holding ten.
 *
 * These tests assert the **final database state**, not merely that both requests returned.
 * A test that only checks for a rejection can pass while stock has silently gone negative.
 */
describe('real concurrency', () => {
  let db: TestDatabase;
  let other: TestDatabase;
  let shop: Shop;
  let supported = false;

  beforeAll(async () => {
    db = await createTestDatabase();
    supported = db.supportsConcurrency;
    if (supported) other = await db.concurrent();
  });

  afterAll(async () => {
    await other?.close();
    await db?.close();
  });

  beforeEach(async () => {
    if (!supported) return;
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

  async function ledgerSum(productId: string): Promise<number> {
    const { rows } = await db.asServiceRole(() =>
      db.query<{ s: string | null }>(
        `select sum(quantity) as s from inventory_movements where branch_id = $1 and product_id = $2`,
        [shop.branchId, productId],
      ),
    );
    return Number(rows[0]?.s ?? 0);
  }

  const canRun = () => supported;

  it.runIf(canRun())(
    'refuses the second terminal when both sell from the same last units',
    async () => {
      // The scenario the whole locking design exists for.
      const item = await shop.stock({ price: 1000, quantity: 10 });

      const terminalA = sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 8 }],
        payments: [{ method: 'CASH', amount: 8000 }],
        idempotencyKey: 'race-terminal-a-00000001',
      });
      const terminalB = sell(other, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 7 }],
        payments: [{ method: 'CASH', amount: 7000 }],
        idempotencyKey: 'race-terminal-b-00000001',
      });

      const results = await Promise.allSettled([terminalA, terminalB]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly one may succeed: 8 + 7 = 15 from a shelf of 10.
      expect(fulfilled, 'both terminals sold from stock that could not cover both').toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0]!.reason), 'the loser failed for a reason other than stock').toMatch(
        /INSUFFICIENT_STOCK/,
      );

      // The state, not just the responses.
      const remaining = await stockOf(item);
      expect(remaining, 'stock went negative under contention').toBeGreaterThanOrEqual(0);
      expect([2, 3]).toContain(remaining); // 10-8 or 10-7
      expect(remaining, 'the cached total drifted from the ledger').toBe(await ledgerSum(item));

      const sales = await db.asServiceRole(() =>
        db.query<{ n: number }>(`select count(*)::int as n from sales`),
      );
      expect(sales.rows[0]!.n).toBe(1);
    },
    120_000,
  );

  it.runIf(canRun())(
    'lets both through when stock covers both, without losing an update',
    async () => {
      // The other half of the guarantee: the lock must serialise, not reject.
      const item = await shop.stock({ price: 1000, quantity: 100 });

      const results = await Promise.allSettled([
        sell(db, shop.ownerUserId, shop.branchId, {
          items: [{ product_id: item, quantity: 8 }],
          payments: [{ method: 'CASH', amount: 8000 }],
          idempotencyKey: 'race-both-ok-a-000000001',
        }),
        sell(other, shop.ownerUserId, shop.branchId, {
          items: [{ product_id: item, quantity: 7 }],
          payments: [{ method: 'CASH', amount: 7000 }],
          idempotencyKey: 'race-both-ok-b-000000001',
        }),
      ]);

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

      // A lost update would leave 92 or 93 rather than 85.
      expect(await stockOf(item), 'an update was lost under contention').toBe(85);
      expect(await ledgerSum(item)).toBe(85);
    },
    120_000,
  );

  it.runIf(canRun())(
    'creates one sale when the same idempotency key arrives on two connections at once',
    async () => {
      // A terminal that retries while its first attempt is still in flight. The unique
      // index is what makes this safe; a check-then-insert would let both through.
      const item = await shop.stock({ price: 1000, quantity: 100 });
      const key = 'race-idempotent-00000001';

      const payload = {
        items: [{ product_id: item, quantity: 3 }],
        payments: [{ method: 'CASH' as const, amount: 3000 }],
        idempotencyKey: key,
      };

      const results = await Promise.allSettled([
        sell(db, shop.ownerUserId, shop.branchId, payload),
        sell(other, shop.ownerUserId, shop.branchId, payload),
      ]);

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      expect(succeeded.length).toBeGreaterThanOrEqual(1);

      const sales = await db.asServiceRole(() =>
        db.query<{ n: number }>(`select count(*)::int as n from sales`),
      );
      expect(sales.rows[0]!.n, 'a concurrent retry created a duplicate sale').toBe(1);
      expect(await stockOf(item), 'stock was deducted twice for one sale').toBe(97);
    },
    120_000,
  );

  it.runIf(canRun())(
    'serialises concurrent stock adjustments without losing one',
    async () => {
      const item = await shop.stock({ price: 1000, quantity: 100 });

      const adjust = (connection: TestDatabase, amount: number, reason: string) =>
        connection.asUser(shop.ownerUserId, () =>
          connection.query(
            `select * from apply_stock_adjustment($1, $2, $3, 'ADJUSTMENT_OUT', $4)`,
            [shop.branchId, item, amount, reason],
          ),
        );

      await Promise.all([
        adjust(db, -10, 'Concurrent adjustment A'),
        adjust(other, -15, 'Concurrent adjustment B'),
      ]);

      expect(await stockOf(item), 'a concurrent adjustment was lost').toBe(75);
      expect(await ledgerSum(item)).toBe(75);
    },
    120_000,
  );

  it.runIf(canRun())(
    'blocks the second transaction until the first commits',
    async () => {
      // Demonstrates the lock directly rather than inferring it from an outcome.
      const item = await shop.stock({ price: 1000, quantity: 10 });

      await db.exec('begin');
      await db.exec(
        `select set_config('request.jwt.claims', '${JSON.stringify({
          sub: shop.ownerUserId,
          role: 'authenticated',
          aud: 'authenticated',
        })}', false)`,
      );
      await db.exec('set role authenticated');
      await db.query(
        `select * from apply_stock_adjustment($1, $2, -5, 'ADJUSTMENT_OUT', 'Holding the lock')`,
        [shop.branchId, item],
      );

      // The second connection must wait rather than read the stale quantity.
      let settled = false;
      const blocked = other
        .asUser(shop.ownerUserId, () =>
          other.query(
            `select * from apply_stock_adjustment($1, $2, -5, 'ADJUSTMENT_OUT', 'Waiting on the lock')`,
            [shop.branchId, item],
          ),
        )
        .finally(() => {
          settled = true;
        });

      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(settled, 'the second transaction was not blocked by the row lock').toBe(false);

      await db.exec('commit');
      await db.exec('reset role');
      await blocked;

      expect(await stockOf(item)).toBe(0);
      expect(await ledgerSum(item)).toBe(0);
    },
    120_000,
  );

  it('reports honestly when the driver cannot express concurrency', () => {
    // Not a placeholder: this asserts the suite refuses to look green on a driver that
    // cannot actually run it, which is how a concurrency gap would otherwise hide.
    if (!supported) {
      expect(db.supportsConcurrency).toBe(false);
      console.warn(
        '\n  real-concurrency: SKIPPED — the in-process driver cannot open a second session.' +
          '\n  Run with CARL_TEST_DB_DRIVER=pg to execute these against real PostgreSQL.\n',
      );
    } else {
      expect(db.supportsConcurrency).toBe(true);
    }
  });
});
