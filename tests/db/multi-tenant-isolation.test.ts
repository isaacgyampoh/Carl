import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { createProduct, createTenant, type TenantFixture } from '../support/fixtures.js';

/**
 * Five businesses on one platform, operated in alternation.
 *
 * Carl serves every client from one application and one database, so the property that
 * matters most is that nothing about one business ever leaks into another — not a product,
 * not a stock level, not a member of staff, and not a PIN.
 *
 * ## What this proves, and what it does not
 *
 * Operations are interleaved across tenants: every round touches each business in turn and
 * then attempts each cross-tenant read and write. That catches state that is shared when it
 * should be scoped — the failure a multi-tenant system actually has.
 *
 * It does NOT run statements in true parallel. PGlite is a single-connection engine, and
 * issuing concurrent identity switches on one connection would test the harness rather than
 * Carl. Genuine parallel load needs a disposable PostgreSQL project, which is recorded as a
 * gap rather than simulated here.
 */
describe('five businesses side by side', () => {
  let db: TestDatabase;
  const shops: (TenantFixture & {
    cashierUserId: string;
    cashierMembershipId: string;
    product: string;
  })[] = [];
  const SHARED_PIN = '4827';

  async function freshAccount(): Promise<string> {
    const id = randomUUID();
    await db.asAdmin(() =>
      db.query(
        `insert into auth.users (
           id, email, instance_id, aud, role, email_confirmed_at, created_at, updated_at,
           raw_app_meta_data, raw_user_meta_data, confirmation_token, recovery_token,
           email_change_token_new, email_change_token_current, email_change, phone_change,
           phone_change_token, reauthentication_token
         ) values ($1, $2, '00000000-0000-0000-0000-000000000000', 'authenticated',
           'authenticated', now(), now(), now(), '{}', '{}', '', '', '', '', '', '', '', '')`,
        [id, `staff-${id}@staff.carl.invalid`],
      ),
    );
    return id;
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    await db.reset();

    for (let i = 0; i < 5; i += 1) {
      const shop = await createTenant(db, { name: `Business ${String.fromCharCode(65 + i)}` });
      const product = await createProduct(db, shop.tenantId, { name: `Product of business ${i}` });
      await db.asServiceRole(() =>
        db.query(
          `insert into inventory (tenant_id, branch_id, product_id, quantity, reorder_level)
           values ($1, $2, $3, 1, 5)`,
          [shop.tenantId, shop.branchId, product],
        ),
      );
      await db.asUser(shop.ownerUserId, () =>
        db.query(`select create_branch($1, 'Second Branch', 'second')`, [shop.tenantId]),
      );
      // The SAME PIN in every business: a PIN names a person inside one business only.
      const cashierUserId = await freshAccount();
      const added = await db.asUser(shop.ownerUserId, () =>
        db.query<{ id: string }>(
          `select add_staff_member($1, $2, 'Cashier', 'cashier', $3) as id`,
          [shop.tenantId, cashierUserId, SHARED_PIN],
        ),
      );
      shops.push({ ...shop, cashierUserId, cashierMembershipId: added.rows[0]!.id, product });
    }
  });

  afterAll(async () => {
    await db?.close();
  });

  it("signs a shared PIN into each business's own cashier, never another's", async () => {
    for (const shop of shops) {
      const { rows } = await db.asServiceRole(() =>
        db.query<{ status: string; user_id: string; tenant_id: string }>(
          `select out_status as status, out_user_id as user_id, out_tenant_id as tenant_id
             from verify_member_pin($1, $2)`,
          [shop.slug, SHARED_PIN],
        ),
      );
      expect(rows[0]!.status).toBe('OK');
      expect(rows[0]!.user_id, `${shop.slug} signed in someone else`).toBe(shop.cashierUserId);
      expect(rows[0]!.tenant_id).toBe(shop.tenantId);
    }
  });

  it('keeps every read inside its own business across interleaved rounds', async () => {
    for (let round = 0; round < 3; round += 1) {
      for (const shop of shops) {
        const low = await db.asUser(shop.ownerUserId, () =>
          db.query<{ product_id: string }>(`select product_id from low_stock_items($1)`, [
            shop.tenantId,
          ]),
        );
        expect(low.rows.map((r) => r.product_id)).toEqual([shop.product]);

        const branches = await db.asUser(shop.ownerUserId, () =>
          db.query<{ tenant_id: string }>(`select tenant_id from branches`),
        );
        expect(branches.rows).toHaveLength(2);
        expect(new Set(branches.rows.map((r) => r.tenant_id))).toEqual(new Set([shop.tenantId]));

        const staff = await db.asUser(shop.ownerUserId, () =>
          db.query<{ tenant_id: string }>(`select tenant_id from tenant_memberships`),
        );
        expect(new Set(staff.rows.map((r) => r.tenant_id))).toEqual(new Set([shop.tenantId]));
      }
    }
  });

  it('returns nothing when one business asks about another by its id', async () => {
    for (const shop of shops) {
      for (const other of shops.filter((s) => s !== shop)) {
        const low = await db.asUser(shop.ownerUserId, () =>
          db.query(`select * from low_stock_items($1)`, [other.tenantId]),
        );
        expect(low.rows, `${shop.slug} read ${other.slug}'s stock`).toHaveLength(0);

        const periods = await db.asUser(shop.ownerUserId, () =>
          db.query<{ year_count: string }>(`select year_count from tenant_sales_periods($1)`, [
            other.tenantId,
          ]),
        );
        expect(Number(periods.rows[0]!.year_count)).toBe(0);
      }
    }
  });

  it('refuses every write one business attempts against another', async () => {
    const [a, b] = shops;
    await expect(
      db.asUser(a!.ownerUserId, () =>
        db.query(`select create_branch($1, 'Hijack Branch', 'hijack')`, [b!.tenantId]),
      ),
    ).rejects.toThrow(/PERMISSION_DENIED/);

    await expect(
      db.asUser(a!.ownerUserId, async () =>
        db.query(`select add_staff_member($1, $2, 'Plant', 'tenant_admin', '6173')`, [
          b!.tenantId,
          await freshAccount(),
        ]),
      ),
    ).rejects.toThrow(/PERMISSION_DENIED/);

    await expect(
      db.asUser(a!.ownerUserId, () =>
        db.query(`select set_member_pin($1, '6173')`, [b!.cashierMembershipId]),
      ),
    ).rejects.toThrow(/PERMISSION_DENIED/);

    await expect(
      db.asUser(a!.cashierUserId, () =>
        db.query(`select set_staff_status($1, 'SUSPENDED')`, [b!.cashierMembershipId]),
      ),
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });
});
