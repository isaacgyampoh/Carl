import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { addMember, createBranch } from '../support/fixtures.js';
import { createShop, sell, type Shop } from '../support/pos.js';

/**
 * The audit log.
 *
 * Its value is entirely in being complete and unalterable. A log with gaps is worse than
 * no log, because it invites the conclusion that what is absent did not happen.
 *
 * These tests assert that every consequential mutation writes an entry, and that nobody —
 * including the service role — can rewrite one afterwards.
 */
describe('audit log', () => {
  let db: TestDatabase;
  let shop: Shop;

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
  });

  async function actions(entityId?: string): Promise<string[]> {
    const { rows } = await db.asServiceRole(() =>
      db.query<{ action: string }>(
        entityId
          ? `select action from audit_logs where entity_id = $1 order by occurred_at`
          : `select action from audit_logs order by occurred_at`,
        entityId ? [entityId] : [],
      ),
    );
    return rows.map((r) => r.action);
  }

  describe('every consequential mutation is recorded', () => {
    it('records tenant provisioning', async () => {
      expect(await actions(shop.tenantId)).toContain('TENANT_PROVISIONED');
    });

    it('records product creation and update', async () => {
      const { rows } = await db.asUser(shop.ownerUserId, () =>
        db.query<{ product_id: string }>(
          `select * from upsert_product($1, 'Audited', 'AUD-100', 2000)`,
          [shop.branchId],
        ),
      );
      await db.asUser(shop.ownerUserId, () =>
        db.query(`select * from upsert_product($1, 'Audited v2', 'AUD-100', 2100, $2)`, [
          shop.branchId,
          rows[0]!.product_id,
        ]),
      );

      const recorded = await actions(rows[0]!.product_id);
      expect(recorded).toContain('PRODUCT_CREATED');
      expect(recorded).toContain('PRODUCT_UPDATED');
      expect(recorded).toContain('PRICE_CHANGED');
    });

    it('records a stock adjustment with its reason', async () => {
      const item = await shop.stock({ price: 1000, quantity: 10 });
      await db.asUser(shop.ownerUserId, () =>
        db.query(
          `select * from apply_stock_adjustment($1, $2, -3, 'DAMAGE', 'Broken in the store room')`,
          [shop.branchId, item],
        ),
      );

      // Identified by what it says, not by where it happens to appear.
      //
      // This previously selected without ORDER BY and took `.at(-1)`. SQL guarantees no
      // ordering without one: PGlite returned insertion order, real PostgreSQL did not, and
      // the test picked up the opening-stock entry instead. A position in an unordered
      // result set is not a way to find a row.
      const { rows } = await db.asServiceRole(() =>
        db.query<{ metadata: { reason: string } }>(
          `select metadata from audit_logs where action = 'STOCK_ADJUSTED'`,
        ),
      );
      expect(rows.map((r) => r.metadata.reason)).toContain('Broken in the store room');
    });

    it('records a sale', async () => {
      const item = await shop.stock({ price: 5000, quantity: 10 });
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      });
      expect(await actions(sale.sale_id)).toContain('SALE_CREATED');
    });

    it('records a refund and a void', async () => {
      const item = await shop.stock({ price: 5000, quantity: 20 });

      const refunded = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      });
      const line = await db.asServiceRole(() =>
        db.query<{ id: string }>(`select id from sale_items where sale_id = $1`, [
          refunded.sale_id,
        ]),
      );
      await db.asUser(shop.ownerUserId, () =>
        db.query(
          `select * from process_return($1, $2::jsonb, 'Faulty', 'audit-refund-00000001', 'CASH'::payment_method)`,
          [refunded.sale_id, JSON.stringify([{ sale_item_id: line.rows[0]!.id, quantity: 1 }])],
        ),
      );

      const voided = await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: item, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      });
      await db.asUser(shop.ownerUserId, () =>
        db.query(`select * from void_sale($1, 'Rung up twice')`, [voided.sale_id]),
      );

      const all = await actions();
      expect(all).toContain('SALE_REFUNDED');
      expect(all).toContain('SALE_VOIDED');
    });

    it('records a purchase being created and received', async () => {
      const item = await shop.stock({ price: 1000, quantity: 0 });
      const purchase = await db.asUser(shop.ownerUserId, () =>
        db.query<{ purchase_id: string }>(`select * from create_purchase($1, $2::jsonb)`, [
          shop.branchId,
          JSON.stringify([{ product_id: item, quantity: 10, unit_cost: 600 }]),
        ]),
      );
      await db.asUser(shop.ownerUserId, () =>
        db.query(`select * from receive_purchase($1, $2::jsonb)`, [
          purchase.rows[0]!.purchase_id,
          JSON.stringify([{ product_id: item, quantity: 10, unit_cost: 600 }]),
        ]),
      );

      const recorded = await actions(purchase.rows[0]!.purchase_id);
      expect(recorded).toContain('PURCHASE_CREATED');
      expect(recorded).toContain('PURCHASE_RECEIVED');
    });

    it('records a transfer through its whole lifecycle', async () => {
      const kumasi = await createBranch(db, shop.tenantId, 'kumasi-audit');
      const item = await shop.stock({ price: 1000, quantity: 50 });

      const transfer = await db.asUser(shop.ownerUserId, () =>
        db.query<{ transfer_id: string }>(
          `select * from create_stock_transfer($1, $2, $3::jsonb)`,
          [shop.branchId, kumasi, JSON.stringify([{ product_id: item, quantity: 5 }])],
        ),
      );
      const id = transfer.rows[0]!.transfer_id;

      await db.asUser(shop.ownerUserId, () =>
        db.query(`select * from dispatch_stock_transfer($1)`, [id]),
      );
      await db.asUser(shop.ownerUserId, () =>
        db.query(`select * from receive_stock_transfer($1)`, [id]),
      );

      const recorded = await actions(id);
      expect(recorded).toContain('TRANSFER_CREATED');
      expect(recorded).toContain('TRANSFER_DISPATCHED');
      expect(recorded).toContain('TRANSFER_RECEIVED');
    });

    it('records device activation and revocation', async () => {
      const device = await db.asServiceRole(async () => {
        const { rows } = await db.query<{ id: string }>(
          `insert into devices (tenant_id, branch_id, code, name) values ($1, $2, 'pos-audit', 'Audit Till') returning id`,
          [shop.tenantId, shop.branchId],
        );
        return rows[0]!.id;
      });

      const code = await db.asUser(shop.ownerUserId, () =>
        db.query<{ code: string }>(`select * from issue_activation_code($1, $2, 24)`, [
          device,
          PEPPER,
        ]),
      );
      await db.asServiceRole(() =>
        db.query(`select * from activate_device($1, $2, 'audit-install')`, [
          code.rows[0]!.code,
          PEPPER,
        ]),
      );
      await db.asUser(shop.ownerUserId, () =>
        db.query(`select revoke_device($1, 'End of audit test')`, [device]),
      );

      const recorded = await actions(device);
      expect(recorded).toContain('DEVICE_ACTIVATION_CODE_ISSUED');
      expect(recorded).toContain('DEVICE_ACTIVATED');
      expect(recorded).toContain('DEVICE_REVOKED');
    });

    it('records a cash session opening and closing, with the variance', async () => {
      const register = await db.asServiceRole(() =>
        db.query<{ id: string }>(`select id from cash_registers where branch_id = $1 limit 1`, [
          shop.branchId,
        ]),
      );
      const session = await db.asUser(shop.ownerUserId, () =>
        db.query<{ session_id: string }>(`select * from open_cash_session($1, 10000)`, [
          register.rows[0]!.id,
        ]),
      );
      await db.asUser(shop.ownerUserId, () =>
        db.query(`select * from close_cash_session($1, 9500, 'Short by five cedis')`, [
          session.rows[0]!.session_id,
        ]),
      );

      const { rows } = await db.asServiceRole(() =>
        db.query<{ action: string; metadata: { variance?: number } }>(
          `select action, metadata from audit_logs where entity_id = $1 order by occurred_at`,
          [session.rows[0]!.session_id],
        ),
      );
      expect(rows.map((r) => r.action)).toEqual(['CASH_SESSION_OPENED', 'CASH_SESSION_CLOSED']);
      expect(Number(rows[1]!.metadata.variance)).toBe(-500);
    });

    it('records an expense being created and approved', async () => {
      const { userId } = await addMember(db, shop.tenantId, { roleKey: 'supervisor' });
      const expense = await db.asUser(userId, () =>
        db.query<{ expense_id: string }>(
          `select * from record_expense($1, 'Audit expense', 4000)`,
          [shop.branchId],
        ),
      );
      await db.asUser(shop.ownerUserId, () =>
        db.query(`select * from approve_expense($1)`, [expense.rows[0]!.expense_id]),
      );

      const recorded = await actions(expense.rows[0]!.expense_id);
      expect(recorded).toContain('EXPENSE_CREATED');
      expect(recorded).toContain('EXPENSE_APPROVED');
    });
  });

  describe('entries carry who and where', () => {
    it('attributes an action to the actor and the branch', async () => {
      const item = await shop.stock({ price: 1000, quantity: 10 });
      await db.asUser(shop.ownerUserId, () =>
        db.query(`select * from apply_stock_adjustment($1, $2, -1, 'DAMAGE', 'Attribution test')`, [
          shop.branchId,
          item,
        ]),
      );

      // Selected by its reason. This one passed before only by luck — the opening-stock
      // entry shares this actor, branch and tenant, so picking the wrong row gave the right
      // answer. It is still no way to find a row.
      const { rows } = await db.asServiceRole(() =>
        db.query<{ actor_id: string; branch_id: string; tenant_id: string }>(
          `select actor_id, branch_id, tenant_id from audit_logs
            where action = 'STOCK_ADJUSTED' and metadata ->> 'reason' = 'Attribution test'`,
        ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor_id).toBe(shop.ownerUserId);
      expect(rows[0]!.branch_id).toBe(shop.branchId);
      expect(rows[0]!.tenant_id).toBe(shop.tenantId);
    });

    it('keeps a departed employee’s actions attributable', async () => {
      // actor_id is deliberately not a foreign key. Removing someone must not erase what
      // they did.
      const { userId } = await addMember(db, shop.tenantId, { roleKey: 'branch_manager' });
      const item = await shop.stock({ price: 1000, quantity: 10 });

      await db.asUser(userId, () =>
        db.query(`select * from apply_stock_adjustment($1, $2, -1, 'DAMAGE', 'Before leaving')`, [
          shop.branchId,
          item,
        ]),
      );

      await db.asAdmin(() => db.query(`delete from auth.users where id = $1`, [userId]));

      // Found by the reason recorded with it, so the assertion is about the departed
      // employee's own entry rather than whichever row the database happened to return
      // last. Without an ORDER BY there is no "last".
      const { rows } = await db.asServiceRole(() =>
        db.query<{ actor_id: string }>(
          `select actor_id from audit_logs
            where action = 'STOCK_ADJUSTED' and metadata ->> 'reason' = 'Before leaving'`,
        ),
      );
      expect(rows, 'the departed employee’s entry is gone entirely').toHaveLength(1);
      expect(rows[0]!.actor_id, 'the departed employee’s action lost its actor').toBe(userId);
    });
  });

  describe('the log cannot be rewritten', () => {
    it('refuses an update, even from the service role', async () => {
      const item = await shop.stock({ price: 1000, quantity: 10 });
      await db.asUser(shop.ownerUserId, () =>
        db.query(`select * from apply_stock_adjustment($1, $2, -1, 'THEFT', 'Suspected theft')`, [
          shop.branchId,
          item,
        ]),
      );

      await db.asServiceRole(async () => {
        await expect(
          db.query(
            `update audit_logs set action = 'NOTHING_HAPPENED' where action = 'STOCK_ADJUSTED'`,
          ),
        ).rejects.toThrow(/IMMUTABLE_RECORD/);
      });
    });

    it('refuses a delete, even from the service role', async () => {
      const item = await shop.stock({ price: 1000, quantity: 10 });
      await db.asUser(shop.ownerUserId, () =>
        db.query(`select * from apply_stock_adjustment($1, $2, -1, 'THEFT', 'Suspected theft')`, [
          shop.branchId,
          item,
        ]),
      );

      await db.asServiceRole(async () => {
        await expect(
          db.query(`delete from audit_logs where action = 'STOCK_ADJUSTED'`),
        ).rejects.toThrow(/IMMUTABLE_RECORD/);
      });
    });

    it('is not writable by an ordinary user at all', async () => {
      await db.asUser(shop.ownerUserId, () =>
        db.expectDenied(
          `insert into audit_logs (tenant_id, action, entity_type) values ($1, 'FABRICATED', 'sale')`,
          [shop.tenantId],
        ),
      );
    });
  });
});
