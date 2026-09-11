import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import {
  addMember,
  createProduct,
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures.js';

/**
 * A business running itself: staff, branches, and what the owner can see.
 *
 * Most of these assertions are refusals, because the functions under test are SECURITY
 * DEFINER and therefore bypass RLS. Every rule RLS would have applied has to be re-stated
 * inside them, and a rule that was forgotten fails open. The tests are the only thing that
 * notices.
 */
describe('staff management', () => {
  let db: TestDatabase;
  let shop: TenantFixture;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.reset();
    shop = await createTenant(db);
  });

  /** A brand-new Auth account, shaped as GoTrue creates one, with no profile yet. */
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

  function addStaff(
    actor: string,
    args: {
      userId: string;
      name?: string;
      role: string;
      pin: string;
      branchIds?: string[] | null;
      tenantId?: string;
    },
  ) {
    return db.asUser(actor, () =>
      db.query<{ id: string }>(
        `select add_staff_member($1, $2, $3, $4, $5, $6::uuid[], null) as id`,
        [
          args.tenantId ?? shop.tenantId,
          args.userId,
          args.name ?? 'Kofi Mensah',
          args.role,
          args.pin,
          args.branchIds ?? null,
        ],
      ),
    );
  }

  async function verifyPin(slug: string, pin: string) {
    const { rows } = await db.asServiceRole(() =>
      db.query<{ status: string; user_id: string | null }>(
        `select out_status as status, out_user_id as user_id from verify_member_pin($1, $2)`,
        [slug, pin],
      ),
    );
    return rows[0]!;
  }

  describe('adding staff', () => {
    it('lets the owner add a cashier who can then sign in with the issued PIN', async () => {
      const userId = await freshAccount();
      const { rows } = await addStaff(shop.ownerUserId, { userId, role: 'cashier', pin: '4827' });
      const membershipId = rows[0]!.id;

      const member = await db.asServiceRole(() =>
        db.query<{ status: string; is_owner: boolean; must_change: boolean; role: string }>(
          `select m.status, m.is_owner, m.pin_must_change as must_change, r.key as role
             from tenant_memberships m
             join membership_roles mr on mr.membership_id = m.id
             join roles r on r.id = mr.role_id
            where m.id = $1`,
          [membershipId],
        ),
      );
      expect(member.rows[0]).toMatchObject({
        status: 'ACTIVE',
        is_owner: false,
        must_change: true,
        role: 'cashier',
      });

      const signIn = await verifyPin(shop.slug, '4827');
      expect(signIn.status).toBe('OK');
      expect(signIn.user_id).toBe(userId);
    });

    it('refuses a cashier', async () => {
      const cashier = await addMember(db, shop.tenantId, { roleKey: 'cashier' });
      const userId = await freshAccount();
      await expect(
        addStaff(cashier.userId, { userId, role: 'cashier', pin: '4827' }),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('refuses a branch manager, who may manage staff but not grant roles', async () => {
      const manager = await addMember(db, shop.tenantId, { roleKey: 'branch_manager' });
      const userId = await freshAccount();
      await expect(
        addStaff(manager.userId, { userId, role: 'cashier', pin: '4827' }),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('never creates a second owner', async () => {
      const userId = await freshAccount();
      await expect(
        addStaff(shop.ownerUserId, { userId, role: 'tenant_owner', pin: '4827' }),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('refuses to attach another business owner, which would let this owner sign in as them', async () => {
      /*
       * The takeover this function was written to prevent. Attach someone else's account,
       * set a PIN you chose, and verify_member_pin mints a session for THAT person.
       */
      const other = await createTenant(db);
      await expect(
        addStaff(shop.ownerUserId, { userId: other.ownerUserId, role: 'cashier', pin: '4827' }),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('refuses to attach a platform administrator', async () => {
      const admin = await createUser(db, { isPlatformAdmin: true });
      await expect(
        addStaff(shop.ownerUserId, { userId: admin, role: 'cashier', pin: '4827' }),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('refuses an account that is not brand new', async () => {
      const userId = await freshAccount();
      await db.asAdmin(() =>
        db.query(`update auth.users set created_at = now() - interval '1 hour' where id = $1`, [
          userId,
        ]),
      );
      await expect(
        addStaff(shop.ownerUserId, { userId, role: 'cashier', pin: '4827' }),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it("refuses to place staff in another business's branch", async () => {
      const other = await createTenant(db);
      const userId = await freshAccount();
      await expect(
        addStaff(shop.ownerUserId, {
          userId,
          role: 'cashier',
          pin: '4827',
          branchIds: [other.branchId],
        }),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('refuses a PIN somebody in the business already uses, and an obvious one', async () => {
      await addStaff(shop.ownerUserId, {
        userId: await freshAccount(),
        role: 'cashier',
        pin: '4827',
      });
      await expect(
        addStaff(shop.ownerUserId, { userId: await freshAccount(), role: 'cashier', pin: '4827' }),
      ).rejects.toThrow(/PIN_TAKEN/);
      await expect(
        addStaff(shop.ownerUserId, { userId: await freshAccount(), role: 'cashier', pin: '1111' }),
      ).rejects.toThrow(/VALIDATION_FAILED/);
    });

    it('leaves nothing behind when it refuses', async () => {
      const userId = await freshAccount();
      await expect(
        addStaff(shop.ownerUserId, { userId, role: 'tenant_owner', pin: '4827' }),
      ).rejects.toThrow();
      const { rows } = await db.asServiceRole(() =>
        db.query<{ profiles: number; memberships: number }>(
          `select (select count(*)::int from profiles where id = $1) as profiles,
                  (select count(*)::int from tenant_memberships where user_id = $1) as memberships`,
          [userId],
        ),
      );
      expect(rows[0]).toEqual({ profiles: 0, memberships: 0 });
    });
  });

  describe('managing existing staff', () => {
    it("stops a branch manager resetting an administrator's PIN and signing in as them", async () => {
      // The pre-existing escalation: a PIN you issued is a PIN you know.
      const admin = await addMember(db, shop.tenantId, { roleKey: 'tenant_admin' });
      const manager = await addMember(db, shop.tenantId, { roleKey: 'branch_manager' });
      await expect(
        db.asUser(manager.userId, () =>
          db.query(`select set_member_pin($1, '5839')`, [admin.membershipId]),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it("still lets the owner reset a cashier's PIN", async () => {
      const { rows } = await addStaff(shop.ownerUserId, {
        userId: await freshAccount(),
        role: 'cashier',
        pin: '4827',
      });
      await db.asUser(shop.ownerUserId, () =>
        db.query(`select set_member_pin($1, '5839')`, [rows[0]!.id]),
      );
      expect((await verifyPin(shop.slug, '5839')).status).toBe('OK');
    });

    it('never lets anyone change the owner, or their own access', async () => {
      const admin = await addMember(db, shop.tenantId, { roleKey: 'tenant_admin' });
      await expect(
        db.asUser(admin.userId, () =>
          db.query(`select set_staff_status($1, 'SUSPENDED')`, [shop.ownerMembershipId]),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
      await expect(
        db.asUser(admin.userId, () =>
          db.query(`select set_staff_status($1, 'SUSPENDED')`, [admin.membershipId]),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('never promotes anyone to owner', async () => {
      const { rows } = await addStaff(shop.ownerUserId, {
        userId: await freshAccount(),
        role: 'cashier',
        pin: '4827',
      });
      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(`select set_staff_role($1, 'tenant_owner')`, [rows[0]!.id]),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it("lets the owner change a cashier's role and branches, and suspend them", async () => {
      const { rows } = await addStaff(shop.ownerUserId, {
        userId: await freshAccount(),
        role: 'cashier',
        pin: '4827',
      });
      const membershipId = rows[0]!.id;

      await db.asUser(shop.ownerUserId, async () => {
        await db.query(`select set_staff_role($1, 'inventory_manager')`, [membershipId]);
        await db.query(`select set_staff_branches($1, $2::uuid[])`, [
          membershipId,
          [shop.branchId],
        ]);
      });

      const role = await db.asServiceRole(() =>
        db.query<{ key: string }>(
          `select r.key from membership_roles mr join roles r on r.id = mr.role_id where mr.membership_id = $1`,
          [membershipId],
        ),
      );
      expect(role.rows.map((r) => r.key)).toEqual(['inventory_manager']);

      await db.asUser(shop.ownerUserId, () =>
        db.query(`select set_staff_status($1, 'SUSPENDED')`, [membershipId]),
      );
      // A suspended member of staff cannot sign in.
      expect((await verifyPin(shop.slug, '4827')).status).not.toBe('OK');
    });
  });

  describe('branches', () => {
    it('lets the owner open a branch, with a register so it can sell', async () => {
      const { rows } = await db.asUser(shop.ownerUserId, () =>
        db.query<{ id: string }>(
          `select create_branch($1, 'Kumasi Branch', 'kumasi', 'Adum', null) as id`,
          [shop.tenantId],
        ),
      );
      const registers = await db.asServiceRole(() =>
        db.query<{ n: number }>(
          `select count(*)::int as n from cash_registers where branch_id = $1`,
          [rows[0]!.id],
        ),
      );
      expect(registers.rows[0]!.n).toBe(1);
    });

    it('refuses a cashier, and a code already in use', async () => {
      const cashier = await addMember(db, shop.tenantId, { roleKey: 'cashier' });
      await expect(
        db.asUser(cashier.userId, () =>
          db.query(`select create_branch($1, 'Kumasi Branch', 'kumasi')`, [shop.tenantId]),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);

      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(`select create_branch($1, 'Another Main', 'main')`, [shop.tenantId]),
        ),
      ).rejects.toThrow(/CONFLICT/);
    });
  });

  describe("a client's monthly fee", () => {
    async function giveSubscription(): Promise<string> {
      return db.asServiceRole(async () => {
        const plan = await db.query<{ id: string }>(
          `insert into subscription_plans (key, name, price) values ('standard-t', 'Standard', 0)
           on conflict (key) do update set name = excluded.name returning id`,
        );
        const sub = await db.query<{ id: string }>(
          `insert into subscriptions (tenant_id, plan_id, price, current_period_end, status)
           values ($1, $2, 0, now() + interval '30 days', 'ACTIVE') returning id`,
          [shop.tenantId, plan.rows[0]!.id],
        );
        return sub.rows[0]!.id;
      });
    }

    it('is set by the platform owner', async () => {
      const subscriptionId = await giveSubscription();
      const platformOwner = await createUser(db, { isPlatformAdmin: true });
      await db.asUser(platformOwner, () =>
        db.query(`select set_client_monthly_fee($1, 30000, 'Agreed in person')`, [shop.tenantId]),
      );
      const { rows } = await db.asServiceRole(() =>
        db.query<{ price: string }>(`select price::text from subscriptions where id = $1`, [
          subscriptionId,
        ]),
      );
      expect(Number(rows[0]!.price)).toBe(30000);
    });

    it('cannot be changed by the client', async () => {
      await giveSubscription();
      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(`select set_client_monthly_fee($1, 0)`, [shop.tenantId]),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });
  });

  describe('reporting for the owner', () => {
    it('reports zero for every period when a business has made no sales', async () => {
      /*
       * Every count, not a sample. `tenant_sales_periods` is a LEFT JOIN from one row of date
       * bounds, and an unfiltered `count(*)` counted that row — a business with no sales was
       * shown one sale for the year. Checking only the filtered today figure missed it.
       */
      const { rows } = await db.asUser(shop.ownerUserId, () =>
        db.query<Record<string, string>>(`select * from tenant_sales_periods($1)`, [shop.tenantId]),
      );
      expect(rows).toHaveLength(1);
      for (const column of [
        'today_count',
        'today_gross',
        'week_count',
        'week_gross',
        'month_count',
        'month_gross',
        'year_count',
        'year_gross',
      ]) {
        expect(Number(rows[0]![column]), `${column} for a business with no sales`).toBe(0);
      }
    });

    it('is not callable anonymously', async () => {
      await expect(
        db.asAnon(() => db.query(`select * from tenant_sales_periods($1)`, [shop.tenantId])),
      ).rejects.toThrow(/permission denied/i);
    });

    it('lists low stock for this business only', async () => {
      const product = await createProduct(db, shop.tenantId, { name: 'Engine oil 1L' });
      await db.asServiceRole(() =>
        db.query(
          `insert into inventory (tenant_id, branch_id, product_id, quantity, reorder_level)
           values ($1, $2, $3, 2, 5)`,
          [shop.tenantId, shop.branchId, product],
        ),
      );

      const mine = await db.asUser(shop.ownerUserId, () =>
        db.query<{ name: string }>(`select name from low_stock_items($1)`, [shop.tenantId]),
      );
      expect(mine.rows.map((r) => r.name)).toEqual(['Engine oil 1L']);

      // Another business asking about this one — by its id — sees nothing.
      const other = await createTenant(db);
      const theirs = await db.asUser(other.ownerUserId, () =>
        db.query(`select * from low_stock_items($1)`, [shop.tenantId]),
      );
      expect(theirs.rows).toHaveLength(0);

      const overview = await db.asUser(shop.ownerUserId, () =>
        db.query<{ products: string; low_stock: string }>(`select * from inventory_overview($1)`, [
          shop.tenantId,
        ]),
      );
      expect(Number(overview.rows[0]!.low_stock)).toBe(1);
    });
  });
});
