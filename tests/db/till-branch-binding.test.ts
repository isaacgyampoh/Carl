import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { addMember, createBranch } from '../support/fixtures.js';
import { createShop, type Shop } from '../support/pos.js';

/**
 * A till sells only for its own branch of its own business.
 *
 * Found in review: app.authorize_device proved a terminal's secret and status, and nothing
 * checked that the terminal belonged to the branch a sale named. Someone who works for two
 * businesses could sign in on business A's till and record a sale at business B, attributed
 * to A's terminal, or file B a "conflict for review" carrying A's till's payload.
 */
describe('a till is bound to its branch', () => {
  let db: TestDatabase;
  let shopA: Shop;
  let shopB: Shop;
  let tillA: string;
  let secretA: string;
  let productB: string;
  let productA: string;
  let person: string;

  const PEPPER = 'test-pepper-not-a-real-secret-value-000000';

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.reset();
    shopA = await createShop(db);
    shopB = await createShop(db);
    productA = await shopA.stock({ price: 1500, quantity: 20 });
    productB = await shopB.stock({ price: 1500, quantity: 20 });

    // Business A's owner also works at business B as a cashier.
    person = shopA.ownerUserId;
    await addMember(db, shopB.tenantId, { userId: person, roleKey: 'cashier' });

    const registered = await db.asUser(person, () =>
      db.query<{ device_id: string }>(`select * from register_device($1, 'Till 1')`, [
        shopA.branchId,
      ]),
    );
    tillA = registered.rows[0]!.device_id;
    const code = await db.asUser(person, () =>
      db.query<{ code: string }>(`select code from issue_activation_code($1, $2, 24)`, [
        tillA,
        PEPPER,
      ]),
    );
    const activated = await db.asServiceRole(() =>
      db.query<{ device_secret: string }>(
        `select * from activate_device($1, $2, 'install-a', 'WINDOWS', '0.2.0')`,
        [code.rows[0]!.code, PEPPER],
      ),
    );
    secretA = activated.rows[0]!.device_secret;
  });

  const cart = (productId: string) => JSON.stringify([{ product_id: productId, quantity: 1 }]);
  const cash = JSON.stringify([{ method: 'CASH', amount: 1500 }]);

  const syncAt = (branchId: string, productId: string) =>
    db.asUser(person, () =>
      db.query<{ sale_id: string | null; had_conflict: boolean }>(
        `select * from sync_offline_sale($1, $2::jsonb, $3::jsonb, $4, now() - interval '5 minutes', $5, $6, $7)`,
        [branchId, cart(productId), cash, randomUUID(), tillA, secretA, PEPPER],
      ),
    );

  const recordsIn = async (tenantId: string) => {
    const { rows } = await db.asServiceRole(() =>
      db.query<{ sales: number; conflicts: number; notifications: number }>(
        `select (select count(*)::int from sales where tenant_id = $1) sales,
                (select count(*)::int from sync_conflicts where tenant_id = $1) conflicts,
                (select count(*)::int from notifications where tenant_id = $1) notifications`,
        [tenantId],
      ),
    );
    return rows[0]!;
  };

  it("still sells at the till's own branch", async () => {
    const result = (await syncAt(shopA.branchId, productA)).rows[0]!;
    expect(result.had_conflict).toBe(false);
    expect(result.sale_id).not.toBeNull();
  });

  it("refuses to sync a sale into another business's branch, and writes nothing there", async () => {
    await expect(syncAt(shopB.branchId, productB)).rejects.toThrow(/FORBIDDEN_BRANCH/);
    expect(await recordsIn(shopB.tenantId)).toEqual({ sales: 0, conflicts: 0, notifications: 0 });
  });

  it("refuses a direct complete_sale at another business's branch with this till", async () => {
    await expect(
      db.asUser(person, () =>
        db.query(
          `select * from complete_sale(
             p_branch_id => $1, p_items => $2::jsonb, p_payments => $3::jsonb,
             p_idempotency_key => $4, p_device_id => $5, p_device_secret => $6, p_pepper => $7)`,
          [shopB.branchId, cart(productB), cash, randomUUID(), tillA, secretA, PEPPER],
        ),
      ),
    ).rejects.toThrow(/FORBIDDEN_BRANCH/);
    expect((await recordsIn(shopB.tenantId)).sales).toBe(0);
  });

  it('refuses a sale for another branch of its own business', async () => {
    const second = await createBranch(db, shopA.tenantId, 'osu', 'Osu');
    await expect(syncAt(second, productA)).rejects.toThrow(/FORBIDDEN_BRANCH/);
    const { rows } = await db.asServiceRole(() =>
      db.query(`select 1 from sales where branch_id = $1`, [second]),
    );
    expect(rows).toHaveLength(0);
  });
});
