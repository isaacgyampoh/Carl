import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { createShop, sell, type Shop } from '../support/pos.js';

/**
 * Offline synchronisation.
 *
 * The scenario that defines this feature: two terminals lose connectivity while a branch
 * holds 10 units. One sells 8, the other sells 7. Both cashiers took money and handed
 * over goods. Hours later both arrive at the server.
 *
 * Carl must not pretend 15 units existed, and must not discard the second sale — deleting
 * the record does not un-sell the goods. So the sale is recorded where it can be, and a
 * conflict is raised for a human to decide: was the count wrong, must stock be sourced,
 * or is a refund owed?
 */
describe('offline sync', () => {
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

  beforeEach(async () => {
    await db.reset();
    shop = await createShop(db);

    // A real activated terminal, through the real activation flow.
    const device = await db.asServiceRole(async () => {
      const { rows } = await db.query<{ id: string }>(
        `insert into devices (tenant_id, branch_id, code, name) values ($1, $2, 'pos-1', 'Till 1') returning id`,
        [shop.tenantId, shop.branchId],
      );
      return rows[0]!.id;
    });
    deviceId = device;

    const code = await db.asUser(shop.ownerUserId, () =>
      db.query<{ code: string }>(`select * from issue_activation_code($1, $2, 24)`, [
        deviceId,
        PEPPER,
      ]),
    );
    const activated = await db.asServiceRole(() =>
      db.query<{ device_secret: string }>(
        `select * from activate_device($1, $2, 'install-1', 'WINDOWS', '1.0.0')`,
        [code.rows[0]!.code, PEPPER],
      ),
    );
    deviceSecret = activated.rows[0]!.device_secret;
  });

  interface SyncResult {
    sale_id: string | null;
    sale_number: string | null;
    total: string | null;
    was_replayed: boolean;
    had_conflict: boolean;
    conflict_id: string | null;
  }

  async function syncSale(
    userId: string,
    options: {
      productId: string;
      quantity: number;
      amount: number;
      soldAt: string;
      key: string;
      secret?: string;
    },
  ): Promise<SyncResult> {
    const { rows } = await db.asUser(userId, () =>
      db.query<SyncResult>(
        `select * from sync_offline_sale(
           $1, $2::jsonb, $3::jsonb, $4, $5::timestamptz, $6, $7, $8
         )`,
        [
          shop.branchId,
          JSON.stringify([{ product_id: options.productId, quantity: options.quantity }]),
          JSON.stringify([{ method: 'CASH', amount: options.amount }]),
          options.key,
          options.soldAt,
          deviceId,
          options.secret ?? deviceSecret,
          PEPPER,
        ],
      ),
    );
    return rows[0]!;
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

  const hoursAgo = (n: number) => new Date(Date.now() - n * 3600_000).toISOString();

  describe('the two-terminal oversell', () => {
    it('accepts the first sale and raises a conflict for the second', async () => {
      const item = await shop.stock({ price: 1000, quantity: 10 });

      const first = await syncSale(shop.ownerUserId, {
        productId: item,
        quantity: 8,
        amount: 8000,
        soldAt: hoursAgo(4),
        key: 'offline-terminal-a-000001',
      });
      expect(first.had_conflict).toBe(false);
      expect(first.sale_id).not.toBeNull();
      expect(await stockOf(item)).toBe(2);

      // Terminal B sold 7 while offline. Only 2 remain.
      const second = await syncSale(shop.ownerUserId, {
        productId: item,
        quantity: 7,
        amount: 7000,
        soldAt: hoursAgo(3),
        key: 'offline-terminal-b-000001',
      });

      expect(second.had_conflict, 'the oversell was accepted silently').toBe(true);
      expect(second.conflict_id).not.toBeNull();
      expect(second.sale_id).toBeNull();

      // Stock is not driven negative, and the first sale is untouched.
      expect(await stockOf(item)).toBe(2);
    });

    it('records the conflict with the transaction exactly as the terminal had it', async () => {
      // A reviewer needs to see what the cashier actually did, not an interpretation.
      const item = await shop.stock({ price: 1000, quantity: 1 });

      const result = await syncSale(shop.ownerUserId, {
        productId: item,
        quantity: 5,
        amount: 5000,
        soldAt: hoursAgo(2),
        key: 'offline-conflict-00000001',
      });

      const { rows } = await db.asServiceRole(() =>
        db.query<{
          conflict_type: string;
          status: string;
          detail: string;
          payload: { items: { product_id: string; quantity: number }[] };
        }>(`select conflict_type, status, detail, payload from sync_conflicts where id = $1`, [
          result.conflict_id,
        ]),
      );

      expect(rows[0]!.conflict_type).toBe('INSUFFICIENT_STOCK');
      expect(rows[0]!.status).toBe('OPEN');
      expect(rows[0]!.detail).toMatch(/Requested/);
      expect(rows[0]!.payload.items[0]!.quantity).toBe(5);
    });

    it('raises a notification so the conflict is not only discoverable by looking', async () => {
      const item = await shop.stock({ price: 1000, quantity: 1 });
      await syncSale(shop.ownerUserId, {
        productId: item,
        quantity: 9,
        amount: 9000,
        soldAt: hoursAgo(1),
        key: 'offline-notify-000000001',
      });

      const { rows } = await db.asServiceRole(() =>
        db.query<{ kind: string; severity: string }>(
          `select kind, severity from notifications where kind = 'SYNC_CONFLICT'`,
        ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.severity).toBe('WARNING');
    });
  });

  describe('replay protection', () => {
    it('does not duplicate a sale when a terminal re-sends its queue', async () => {
      // Guaranteed to happen: an interrupted sync means the terminal cannot know which of
      // its queued sales the server accepted, so it sends them all again.
      const item = await shop.stock({ price: 1000, quantity: 100 });
      const key = 'offline-replay-000000001';

      const first = await syncSale(shop.ownerUserId, {
        productId: item,
        quantity: 3,
        amount: 3000,
        soldAt: hoursAgo(5),
        key,
      });
      const replay = await syncSale(shop.ownerUserId, {
        productId: item,
        quantity: 3,
        amount: 3000,
        soldAt: hoursAgo(5),
        key,
      });

      expect(replay.sale_id).toBe(first.sale_id);
      expect(replay.was_replayed).toBe(true);
      expect(replay.had_conflict).toBe(false);
      expect(await stockOf(item), 'a replayed sale moved stock twice').toBe(97);

      const sales = await db.asServiceRole(() => db.query(`select id from sales`));
      expect(sales.rows).toHaveLength(1);
    });

    it('never loses a transaction, whichever way it goes', async () => {
      // The guarantee that matters most: every queued sale ends up either as a sale or as
      // a conflict. Nothing is silently dropped.
      const item = await shop.stock({ price: 1000, quantity: 5 });

      const results = [];
      for (let i = 0; i < 4; i += 1) {
        results.push(
          await syncSale(shop.ownerUserId, {
            productId: item,
            quantity: 2,
            amount: 2000,
            soldAt: hoursAgo(6 - i),
            key: `offline-batch-00000000${i}`,
          }),
        );
      }

      const accepted = results.filter((r) => r.sale_id !== null).length;
      const conflicted = results.filter((r) => r.had_conflict).length;
      expect(accepted + conflicted, 'a queued transaction went missing').toBe(4);
      expect(accepted).toBe(2); // 5 units covers two sales of 2, then 1 remains
      expect(conflicted).toBe(2);
    });
  });

  describe('provenance', () => {
    it('records the sale under the time it was actually made', async () => {
      // created_at is when the row reached the server. Reporting on that would put a
      // Saturday's takings into Monday.
      const item = await shop.stock({ price: 1000, quantity: 10 });
      const soldAt = hoursAgo(20);

      const result = await syncSale(shop.ownerUserId, {
        productId: item,
        quantity: 1,
        amount: 1000,
        soldAt,
        key: 'offline-provenance-00001',
      });

      const { rows } = await db.asServiceRole(() =>
        db.query<{ sold_at: string; is_offline_sale: boolean; device_id: string }>(
          `select sold_at, is_offline_sale, device_id from sales where id = $1`,
          [result.sale_id],
        ),
      );
      expect(new Date(rows[0]!.sold_at).toISOString()).toBe(new Date(soldAt).toISOString());
      expect(rows[0]!.is_offline_sale).toBe(true);
      expect(rows[0]!.device_id).toBe(deviceId);
    });

    it('refuses a sale dated in the future', async () => {
      // A clock problem on the terminal. Accepting it would put revenue in a day that has
      // not happened.
      const item = await shop.stock({ price: 1000, quantity: 10 });
      await expect(
        syncSale(shop.ownerUserId, {
          productId: item,
          quantity: 1,
          amount: 1000,
          soldAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
          key: 'offline-future-000000001',
        }),
      ).rejects.toThrow(/SYNC_PAYLOAD_INVALID/);
    });
  });

  describe('device authorisation is a hard stop, not a conflict', () => {
    it('refuses a revoked terminal outright', async () => {
      // Recording this as "needs review" would let a stolen terminal keep filing sales for
      // someone to rubber-stamp.
      const item = await shop.stock({ price: 1000, quantity: 10 });
      await db.asUser(shop.ownerUserId, () =>
        db.query(`select revoke_device($1, 'Reported stolen')`, [deviceId]),
      );

      await expect(
        syncSale(shop.ownerUserId, {
          productId: item,
          quantity: 1,
          amount: 1000,
          soldAt: hoursAgo(1),
          key: 'offline-revoked-00000001',
        }),
      ).rejects.toThrow(/DEVICE_REVOKED/);

      const conflicts = await db.asServiceRole(() => db.query(`select id from sync_conflicts`));
      expect(conflicts.rows, 'a revoked device produced a reviewable conflict').toHaveLength(0);
    });

    it('refuses a wrong device secret outright', async () => {
      const item = await shop.stock({ price: 1000, quantity: 10 });
      await expect(
        syncSale(shop.ownerUserId, {
          productId: item,
          quantity: 1,
          amount: 1000,
          soldAt: hoursAgo(1),
          key: 'offline-badsecret-000001',
          secret: 'f'.repeat(64),
        }),
      ).rejects.toThrow(/DEVICE_NOT_ACTIVATED/);
    });

    it('refuses a suspended tenant outright', async () => {
      const item = await shop.stock({ price: 1000, quantity: 10 });
      await db.asServiceRole(() =>
        db.query(
          `update tenants set status = 'SUSPENDED', suspended_at = now(), suspension_reason = 'Non-payment' where id = $1`,
          [shop.tenantId],
        ),
      );

      await expect(
        syncSale(shop.ownerUserId, {
          productId: item,
          quantity: 1,
          amount: 1000,
          soldAt: hoursAgo(1),
          key: 'offline-suspended-000001',
        }),
      ).rejects.toThrow(/TENANT_SUSPENDED/);
    });
  });

  describe('offline authorisation window', () => {
    it('extends the window on a successful sync', async () => {
      // The terminal has just proved it can reach the server and is still trusted.
      const item = await shop.stock({ price: 1000, quantity: 10 });

      await db.asServiceRole(() =>
        db.query(`update devices set authorized_until = now() + interval '2 hours' where id = $1`, [
          deviceId,
        ]),
      );

      await syncSale(shop.ownerUserId, {
        productId: item,
        quantity: 1,
        amount: 1000,
        soldAt: hoursAgo(1),
        key: 'offline-extend-000000001',
      });

      const { rows } = await db.asServiceRole(() =>
        db.query<{ hours: string }>(
          `select extract(epoch from (authorized_until - now())) / 3600 as hours
           from devices where id = $1`,
          [deviceId],
        ),
      );
      // Back to the full seven-day grace period.
      expect(Number(rows[0]!.hours)).toBeGreaterThan(160);
    });

    it('reports the window and server time when a terminal reconnects', async () => {
      const { rows } = await db.asServiceRole(() =>
        db.query<{
          tenant_id: string;
          branch_id: string;
          authorized_until: string;
          server_time: string;
        }>(`select * from device_sync_state($1, $2, $3)`, [deviceId, deviceSecret, PEPPER]),
      );

      expect(rows[0]!.tenant_id).toBe(shop.tenantId);
      expect(rows[0]!.branch_id).toBe(shop.branchId);
      expect(new Date(rows[0]!.authorized_until).getTime()).toBeGreaterThan(Date.now());
      // Lets the terminal detect its own clock drift.
      expect(new Date(rows[0]!.server_time).getTime()).toBeCloseTo(Date.now(), -5);
    });

    it('stops a terminal whose window has passed', async () => {
      await db.asServiceRole(() =>
        db.query(
          `update devices set authorized_until = now() - interval '1 minute' where id = $1`,
          [deviceId],
        ),
      );

      await expect(
        db.asServiceRole(() =>
          db.query(`select * from device_sync_state($1, $2, $3)`, [deviceId, deviceSecret, PEPPER]),
        ),
      ).rejects.toThrow(/DEVICE_AUTHORIZATION_EXPIRED/);
    });
  });

  describe('resolving a conflict', () => {
    it('requires an explanation before closing', async () => {
      const item = await shop.stock({ price: 1000, quantity: 1 });
      const result = await syncSale(shop.ownerUserId, {
        productId: item,
        quantity: 5,
        amount: 5000,
        soldAt: hoursAgo(1),
        key: 'offline-resolve-00000001',
      });

      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(
            `select * from resolve_sync_conflict($1, 'DISMISSED'::sync_conflict_status, '')`,
            [result.conflict_id],
          ),
        ),
      ).rejects.toThrow(/VALIDATION_FAILED/);
    });

    it('records who resolved it and how', async () => {
      const item = await shop.stock({ price: 1000, quantity: 1 });
      const result = await syncSale(shop.ownerUserId, {
        productId: item,
        quantity: 5,
        amount: 5000,
        soldAt: hoursAgo(1),
        key: 'offline-resolve-00000002',
      });

      await db.asUser(shop.ownerUserId, () =>
        db.query(
          `select * from resolve_sync_conflict($1, 'RESOLVED'::sync_conflict_status, 'Stock miscounted at intake; adjusted')`,
          [result.conflict_id],
        ),
      );

      const { rows } = await db.asServiceRole(() =>
        db.query<{ status: string; resolved_by: string; resolution_note: string }>(
          `select status, resolved_by, resolution_note from sync_conflicts where id = $1`,
          [result.conflict_id],
        ),
      );
      expect(rows[0]!.status).toBe('RESOLVED');
      expect(rows[0]!.resolved_by).toBe(shop.ownerUserId);
      expect(rows[0]!.resolution_note).toMatch(/miscounted/);

      const audit = await db.asServiceRole(() =>
        db.query(`select id from audit_logs where action = 'SYNC_CONFLICT_RESOLVED'`),
      );
      expect(audit.rows).toHaveLength(1);
    });
  });

  describe('an online sale is unaffected', () => {
    it('records without offline provenance', async () => {
      const item = await shop.stock({ price: 1000, quantity: 10 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 1000 }],
      });

      const { rows } = await db.asServiceRole(() =>
        db.query<{ is_offline_sale: boolean }>(`select is_offline_sale from sales where id = $1`, [
          sale.sale_id,
        ]),
      );
      expect(rows[0]!.is_offline_sale).toBe(false);
    });
  });
});
