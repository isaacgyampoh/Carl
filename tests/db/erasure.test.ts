import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { createShop, sell, type Shop } from '../support/pos.js';

/**
 * What can and cannot be erased.
 *
 * Two forces pull against each other here. An audit log and an inventory ledger are
 * append-only because a record that can be edited is not a record. But people and
 * businesses have a right to be forgotten, and "the database will not let us" is not an
 * answer to a lawful erasure request.
 *
 * These tests pin where the line currently falls, so it is known in advance rather than
 * discovered during the request. One of them documents a limitation rather than a
 * guarantee, and says so.
 */
describe('erasure', () => {
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

  describe('a person', () => {
    /**
     * The ledger no longer blocks erasure.
     *
     * `inventory_movements.performed_by` used to be a foreign key with ON DELETE SET NULL
     * against an append-only table — a combination that could never succeed, because the
     * cascade's own UPDATE was refused by the trigger. Migration 0026 removed the foreign
     * key rather than weakening the trigger: the column and its index remain, so
     * attribution survives, and the ledger stays immutable.
     */
    it('is not blocked by the inventory ledger', async () => {
      // Stocked for the side effect: the opening-stock adjustment is what puts an
      // attributed row in the ledger.
      await shop.stock({ name: 'Rice', price: 8000, quantity: 50 });
      const staffId = await db.asServiceRole(async () => {
        const { rows } = await db.query<{ id: string }>(
          `select performed_by as id from inventory_movements
            where tenant_id = $1 and performed_by is not null limit 1`,
          [shop.tenantId],
        );
        return rows[0]?.id;
      });
      expect(staffId, 'no movement was attributed to anyone').toBeDefined();

      // Nothing but the opening stock has been posted, so the ledger is the only thing
      // referencing this person. It does not stand in the way.
      await expect(
        db.asServiceRole(() => db.query(`delete from profiles where id = $1`, [staffId])),
      ).resolves.toBeDefined();
    });

    it('leaves the movements they posted intact', async () => {
      await shop.stock({ name: 'Rice', price: 8000, quantity: 50 });
      const before = await db.asServiceRole(() =>
        db.query<{ count: string }>(
          `select count(*)::text as count from inventory_movements where tenant_id = $1`,
          [shop.tenantId],
        ),
      );

      await db.asServiceRole(() =>
        db.query(`delete from profiles where id = $1`, [shop.ownerUserId]),
      );

      const after = await db.asServiceRole(() =>
        db.query<{ count: string }>(
          `select count(*)::text as count from inventory_movements where tenant_id = $1`,
          [shop.tenantId],
        ),
      );
      // Erasing the person does not erase the stock history. The goods still moved.
      expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
      expect(Number(after.rows[0]!.count)).toBeGreaterThan(0);
    });

    /**
     * This test documents a LIMITATION, not a guarantee.
     *
     * `sales.cashier_id` is ON DELETE RESTRICT, so once a person has rung up a single sale
     * they can no longer be deleted. The ledger was fixed in migration 0026; this was not,
     * and the two are inconsistent — erasure succeeds or fails depending only on whether
     * the employee happened to sell anything.
     *
     * It is pinned rather than fixed because the fix is a retention decision. A sale is a
     * financial record and the cashier is part of it; whether that attribution may be
     * severed to satisfy an erasure request is a question for whoever answers to the
     * regulator, not something to change quietly in a test-fixing commit.
     */
    it('cannot currently be deleted once they have made a sale', async () => {
      const productId = await shop.stock({ name: 'Rice', price: 8000, quantity: 50 });
      await sell(db, shop.ownerUserId, shop.branchId, {
        items: [{ product_id: productId, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 8000 }],
      });

      await expect(
        db.asServiceRole(() => db.query(`delete from profiles where id = $1`, [shop.ownerUserId])),
      ).rejects.toThrow(/RESTRICT|violates foreign key/i);
    });
  });

  describe('a business', () => {
    /**
     * This test documents a LIMITATION, not a guarantee.
     *
     * `audit_logs.tenant_id` cascades on delete, but `audit_logs` is append-only, so the
     * cascade is refused and the tenant cannot be removed. Every tenant has audit entries
     * from the moment it is provisioned, so this applies to all of them, always.
     *
     * The schema therefore contains a contradiction: the foreign key says the rows should
     * be deleted with the tenant, and the trigger says they may never be deleted at all.
     *
     * It is pinned here rather than fixed because the fix is a retention decision, not a
     * technical one — whether Carl keeps an audit trail for a business that has exercised
     * a right to erasure is a question for the people who answer to the regulator. Both
     * available answers are defensible; picking one silently is not.
     */
    it('cannot currently be hard-deleted, because its audit log may not be', async () => {
      await expect(
        db.asServiceRole(() => db.query(`delete from tenants where id = $1`, [shop.tenantId])),
      ).rejects.toThrow(/IMMUTABLE_RECORD|append-only/i);
    });

    it('can be closed, which is the supported path today', async () => {
      // Stocked before closing: a cancelled tenant cannot transact at all, which is the
      // very thing being asserted below.
      const productId = await shop.stock({ name: 'Rice', price: 8000, quantity: 10 });

      // Soft-closure: the tenant stops transacting, and the record survives.
      // `cancelled_at` is not optional: a CHECK constraint requires a closure to carry
      // its date, so a business cannot be closed without a record of when.
      await db.asServiceRole(() =>
        db.query(
          `update tenants set status = 'CANCELLED', cancelled_at = now() where id = $1`,
          [shop.tenantId],
        ),
      );

      await expect(
        sell(db, shop.ownerUserId, shop.branchId, {
          items: [{ product_id: productId, quantity: 1 }],
          payments: [{ method: 'CASH', amount: 8000 }],
        }),
      ).rejects.toThrow(/TENANT_SUSPENDED/);
    });
  });
});
