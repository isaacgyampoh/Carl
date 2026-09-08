import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { addMember } from '../support/fixtures.js';
import { createShop, grantPermission, sell, type Shop } from '../support/pos.js';

/**
 * The cash drawer.
 *
 * At the end of a shift someone counts it, and Carl must be able to say what should be
 * there. The value is entirely in the difference: a till that reconciles tells you
 * nothing, and one that does not needs investigating the same day, while the people
 * involved are still on site.
 */
describe('cash register', () => {
  let db: TestDatabase;
  let shop: Shop;
  let registerId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.reset();
    shop = await createShop(db);
    const { rows } = await db.asServiceRole(() =>
      db.query<{ id: string }>(`select id from cash_registers where branch_id = $1 limit 1`, [
        shop.branchId,
      ]),
    );
    registerId = rows[0]!.id;
  });

  async function open(userId: string, float = 0): Promise<string> {
    const { rows } = await db.asUser(userId, () =>
      db.query<{ session_id: string }>(`select * from open_cash_session($1, $2, null)`, [
        registerId,
        float,
      ]),
    );
    return rows[0]!.session_id;
  }

  async function close(userId: string, sessionId: string, counted: number, note?: string) {
    const { rows } = await db.asUser(userId, () =>
      db.query<{ expected_cash: string; counted_cash: string; variance: string }>(
        `select * from close_cash_session($1, $2, $3)`,
        [sessionId, counted, note ?? null],
      ),
    );
    return {
      expected: Number(rows[0]!.expected_cash),
      counted: Number(rows[0]!.counted_cash),
      variance: Number(rows[0]!.variance),
    };
  }

  describe('opening', () => {
    it('opens a session with a float', async () => {
      const session = await open(shop.ownerUserId, 20000);
      const { rows } = await db.asServiceRole(() =>
        db.query<{ status: string; opening_float: string }>(
          `select status, opening_float from cash_sessions where id = $1`,
          [session],
        ),
      );
      expect(rows[0]!.status).toBe('OPEN');
      expect(Number(rows[0]!.opening_float)).toBe(20000);
    });

    it('refuses a second open session on the same register', async () => {
      // Two sessions on one drawer means each records half the story and neither
      // reconciles.
      await open(shop.ownerUserId, 10000);
      await expect(open(shop.ownerUserId, 10000)).rejects.toThrow(/REGISTER_ALREADY_OPEN/);
    });

    it('refuses a member without register.open', async () => {
      const { userId } = await addMember(db, shop.tenantId, { roleKey: 'accountant' });
      await expect(open(userId)).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('allows a new session once the previous one is closed', async () => {
      const first = await open(shop.ownerUserId, 10000);
      await close(shop.ownerUserId, first, 10000);
      await expect(open(shop.ownerUserId, 10000)).resolves.toBeTruthy();
    });
  });

  describe('reconciliation', () => {
    it('expects the float plus cash taken', async () => {
      const item = await shop.stock({ price: 25000, quantity: 10 });
      const session = await open(shop.ownerUserId, 20000);

      await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 25000 }],
      });

      const result = await close(shop.ownerUserId, session, 45000);
      expect(result.expected).toBe(45000);
      expect(result.variance).toBe(0);
    });

    it('excludes mobile money from what should be in the drawer', async () => {
      // The most common reconciliation mistake: counting electronic payments as cash.
      const item = await shop.stock({ price: 30000, quantity: 10 });
      const session = await open(shop.ownerUserId, 10000);

      await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'MOMO', amount: 30000, reference: 'MM-001' }],
      });

      const result = await close(shop.ownerUserId, session, 10000);
      expect(result.expected).toBe(10000);
      expect(result.variance).toBe(0);
    });

    it('accounts for change given out of the drawer', async () => {
      const item = await shop.stock({ price: 25000, quantity: 10 });
      const session = await open(shop.ownerUserId, 20000);

      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 30000 }],
      });
      expect(sale.change_given).toBe(5000);

      // 20000 float + 30000 taken - 5000 change
      const result = await close(shop.ownerUserId, session, 45000);
      expect(result.expected).toBe(45000);
      expect(result.variance).toBe(0);
    });

    it('accounts for cash paid in and taken out', async () => {
      const session = await open(shop.ownerUserId, 10000);

      await db.asUser(shop.ownerUserId, async () => {
        await db.query(
          `select * from record_cash_movement($1, 'IN', 5000, 'Float top-up from safe')`,
          [session],
        );
        await db.query(
          `select * from record_cash_movement($1, 'DROP', 3000, 'Safe drop, mid-shift')`,
          [session],
        );
      });

      const result = await close(shop.ownerUserId, session, 12000);
      expect(result.expected).toBe(12000);
      expect(result.variance).toBe(0);
    });

    it('accounts for a cash expense', async () => {
      const session = await open(shop.ownerUserId, 20000);

      await db.asUser(shop.ownerUserId, () =>
        db.query(`select * from record_expense($1, 'Fuel for delivery', 4500)`, [shop.branchId]),
      );

      const result = await close(shop.ownerUserId, session, 15500);
      expect(result.expected).toBe(15500);
      expect(result.variance).toBe(0);
    });

    it('accounts for a cash refund', async () => {
      const item = await shop.stock({ price: 10000, quantity: 10 });
      const session = await open(shop.ownerUserId, 20000);

      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 10000 }],
      });
      const { rows } = await db.asServiceRole(() =>
        db.query<{ id: string }>(`select id from sale_items where sale_id = $1`, [sale.sale_id]),
      );

      await db.asUser(shop.ownerUserId, () =>
        db.query(
          `select * from process_return($1, $2::jsonb, 'Wrong item', 'refund-key-0000000001', 'CASH'::payment_method)`,
          [sale.sale_id, JSON.stringify([{ sale_item_id: rows[0]!.id, quantity: 1 }])],
        ),
      );

      // 20000 float + 10000 taken - 10000 refunded
      const result = await close(shop.ownerUserId, session, 20000);
      expect(result.expected).toBe(20000);
      expect(result.variance).toBe(0);
    });
  });

  describe('variance', () => {
    it('reports a shortfall as negative', async () => {
      const session = await open(shop.ownerUserId, 20000);
      const result = await close(shop.ownerUserId, session, 19500, 'Short by 5 cedis, unexplained');
      expect(result.expected).toBe(20000);
      expect(result.variance).toBe(-500);
    });

    it('reports a surplus as positive', async () => {
      const session = await open(shop.ownerUserId, 20000);
      const result = await close(shop.ownerUserId, session, 20200, 'Over, likely a miscount');
      expect(result.variance).toBe(200);
    });

    it('refuses to close on a variance with no explanation', async () => {
      // Silent variances are how a slow leak from a till goes unnoticed for months.
      const session = await open(shop.ownerUserId, 20000);
      await expect(close(shop.ownerUserId, session, 15000)).rejects.toThrow(/VALIDATION_FAILED/);

      const { rows } = await db.asServiceRole(() =>
        db.query<{ status: string }>(`select status from cash_sessions where id = $1`, [session]),
      );
      expect(rows[0]!.status, 'the session was closed despite an unexplained variance').toBe(
        'OPEN',
      );
    });

    it('stores the variance rather than recomputing it later', async () => {
      // The variance is a fact about that shift. Recomputing it against corrected data
      // would erase the discrepancy that was actually found.
      const session = await open(shop.ownerUserId, 20000);
      await close(shop.ownerUserId, session, 18000, 'Investigating with the supervisor');

      const { rows } = await db.asServiceRole(() =>
        db.query<{ variance: string; expected_cash: string; counted_cash: string }>(
          `select variance, expected_cash, counted_cash from cash_sessions where id = $1`,
          [session],
        ),
      );
      expect(Number(rows[0]!.variance)).toBe(-2000);
      expect(Number(rows[0]!.expected_cash)).toBe(20000);
      expect(Number(rows[0]!.counted_cash)).toBe(18000);
    });

    it('refuses to close a session twice', async () => {
      const session = await open(shop.ownerUserId, 10000);
      await close(shop.ownerUserId, session, 10000);
      await expect(close(shop.ownerUserId, session, 10000)).rejects.toThrow(
        /REGISTER_SESSION_CLOSED/,
      );
    });
  });

  describe('cash movements', () => {
    it('requires a reason', async () => {
      // Cash leaving a drawer with no explanation is the most common route for till theft.
      const session = await open(shop.ownerUserId, 10000);
      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(`select * from record_cash_movement($1, 'OUT', 1000, '')`, [session]),
        ),
      ).rejects.toThrow(/VALIDATION_FAILED/);
    });

    it('cannot be edited or deleted after the fact', async () => {
      const session = await open(shop.ownerUserId, 10000);
      const { rows } = await db.asUser(shop.ownerUserId, () =>
        db.query<{ movement_id: string }>(
          `select * from record_cash_movement($1, 'OUT', 1000, 'Petty cash for stationery')`,
          [session],
        ),
      );

      await db.asServiceRole(async () => {
        await expect(
          db.query(`update cash_movements set amount = 1 where id = $1`, [rows[0]!.movement_id]),
        ).rejects.toThrow(/IMMUTABLE_RECORD/);
        await expect(
          db.query(`delete from cash_movements where id = $1`, [rows[0]!.movement_id]),
        ).rejects.toThrow(/IMMUTABLE_RECORD/);
      });
    });

    it('refuses a movement on a closed session', async () => {
      const session = await open(shop.ownerUserId, 10000);
      await close(shop.ownerUserId, session, 10000);
      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(`select * from record_cash_movement($1, 'IN', 500, 'Late top-up')`, [session]),
        ),
      ).rejects.toThrow(/REGISTER_SESSION_CLOSED/);
    });
  });

  describe('expenses', () => {
    it('approves immediately when recorded by someone who can approve', async () => {
      const { rows } = await db.asUser(shop.ownerUserId, () =>
        db.query<{ expense_id: string; reference: string }>(
          `select * from record_expense($1, 'Generator fuel', 12000)`,
          [shop.branchId],
        ),
      );
      expect(rows[0]!.reference).toMatch(/^EXP-\d{6}$/);

      const status = await db.asServiceRole(() =>
        db.query<{ status: string }>(`select status from expenses where id = $1`, [
          rows[0]!.expense_id,
        ]),
      );
      expect(status.rows[0]!.status).toBe('APPROVED');
    });

    it('queues for approval when recorded by someone who cannot approve', async () => {
      const { userId } = await addMember(db, shop.tenantId, { roleKey: 'supervisor' });

      const { rows } = await db.asUser(userId, () =>
        db.query<{ expense_id: string }>(`select * from record_expense($1, 'Taxi fare', 3000)`, [
          shop.branchId,
        ]),
      );

      const status = await db.asServiceRole(() =>
        db.query<{ status: string }>(`select status from expenses where id = $1`, [
          rows[0]!.expense_id,
        ]),
      );
      expect(status.rows[0]!.status).toBe('PENDING_APPROVAL');
    });

    it('refuses to approve a queued expense you recorded yourself', async () => {
      // The sharp case: record while unable to approve, then acquire the permission and
      // sign off your own entry. Without this guard the approval queue is decoration.
      const { userId } = await addMember(db, shop.tenantId, { roleKey: 'supervisor' });

      const { rows } = await db.asUser(userId, () =>
        db.query<{ expense_id: string }>(`select * from record_expense($1, 'Own expense', 5000)`, [
          shop.branchId,
        ]),
      );

      // The expense is queued, because the recorder could not approve at the time.
      const queued = await db.asServiceRole(() =>
        db.query<{ status: string }>(`select status from expenses where id = $1`, [
          rows[0]!.expense_id,
        ]),
      );
      expect(queued.rows[0]!.status).toBe('PENDING_APPROVAL');

      // Now they gain the permission and try to sign off their own entry.
      await grantPermission(db, shop.tenantId, 'supervisor', 'expenses.approve');

      await expect(
        db.asUser(userId, () =>
          db.query(`select * from approve_expense($1)`, [rows[0]!.expense_id]),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);

      // Someone else can.
      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(`select * from approve_expense($1)`, [rows[0]!.expense_id]),
        ),
      ).resolves.toBeTruthy();
    });

    it('approves an approver’s own expense on entry, so a one-manager shop still works', async () => {
      // Documented policy rather than an oversight: a control that makes the feature
      // unusable gets worked around rather than followed.
      const { rows } = await db.asUser(shop.ownerUserId, () =>
        db.query<{ expense_id: string }>(
          `select * from record_expense($1, 'Owner expense', 5000)`,
          [shop.branchId],
        ),
      );
      const status = await db.asServiceRole(() =>
        db.query<{ status: string; approved_by: string }>(
          `select status, approved_by from expenses where id = $1`,
          [rows[0]!.expense_id],
        ),
      );
      expect(status.rows[0]!.status).toBe('APPROVED');
      expect(status.rows[0]!.approved_by).toBe(shop.ownerUserId);
    });

    it('only counts an approved cash expense against the drawer', async () => {
      // An expense awaiting sign-off has not been paid out, so the money is still there.
      const session = await open(shop.ownerUserId, 20000);
      const { userId } = await addMember(db, shop.tenantId, { roleKey: 'supervisor' });

      await db.asUser(userId, () =>
        db.query(`select * from record_expense($1, 'Pending purchase', 5000)`, [shop.branchId]),
      );

      const result = await close(shop.ownerUserId, session, 20000);
      expect(result.expected, 'an unapproved expense was deducted from the drawer').toBe(20000);
      expect(result.variance).toBe(0);
    });

    it('requires a reference for a mobile money expense', async () => {
      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(
            `select * from record_expense($1, 'Airtime', 2000, null, 'MOMO'::payment_method)`,
            [shop.branchId],
          ),
        ),
      ).rejects.toThrow(/PAYMENT_REFERENCE_REQUIRED/);
    });

    it('refuses a cashier', async () => {
      const { userId } = await addMember(db, shop.tenantId, { roleKey: 'cashier' });
      await expect(
        db.asUser(userId, () =>
          db.query(`select * from record_expense($1, 'Helping myself', 50000)`, [shop.branchId]),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });
  });

  describe('a full shift', () => {
    it('reconciles across sales, refunds, movements and expenses', async () => {
      const item = await shop.stock({ price: 10000, quantity: 100 });
      const session = await open(shop.ownerUserId, 50000);

      for (let i = 0; i < 3; i += 1) {
        await sell(db, shop.ownerUserId, shop.branchId, {
          items: [{ product_id: item, quantity: 1 }],
          payments: [{ method: 'CASH', amount: 10000 }],
        });
      }
      await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'MOMO', amount: 10000, reference: 'MM-9' }],
      });

      const refundable = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 10000 }],
      });
      const line = await db.asServiceRole(() =>
        db.query<{ id: string }>(`select id from sale_items where sale_id = $1`, [
          refundable.sale_id,
        ]),
      );
      await db.asUser(shop.ownerUserId, () =>
        db.query(
          `select * from process_return($1, $2::jsonb, 'Faulty', 'shift-refund-000000001', 'CASH'::payment_method)`,
          [refundable.sale_id, JSON.stringify([{ sale_item_id: line.rows[0]!.id, quantity: 1 }])],
        ),
      );

      await db.asUser(shop.ownerUserId, async () => {
        await db.query(`select * from record_cash_movement($1, 'DROP', 20000, 'Safe drop')`, [
          session,
        ]);
        await db.query(`select * from record_expense($1, 'Cleaning supplies', 3500)`, [
          shop.branchId,
        ]);
      });

      // 50000 float + 40000 cash sales - 10000 refund - 20000 drop - 3500 expense
      const result = await close(shop.ownerUserId, session, 56500);
      expect(result.expected).toBe(56500);
      expect(result.variance).toBe(0);
    });
  });
});
