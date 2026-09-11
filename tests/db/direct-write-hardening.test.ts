import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { addMember, createTenant, createUser, type TenantFixture } from '../support/fixtures.js';

/**
 * The REST API is a door too.
 *
 * Every rule about who may change staff, roles, a business or a sign-in identity was
 * enforced in SECURITY DEFINER functions — and every one could be skipped, because the table
 * write policies underneath were broader and `authenticated` held full table privileges. A
 * signed-in user does not have to call the function; they can PATCH the table.
 *
 * Each test below is one of those bypasses, stated as the attack. Every one of them
 * succeeded before migration 0038.
 */
describe('writes that must go through the guarded functions', () => {
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

  describe('staff and roles', () => {
    it("stops a branch manager rewriting an administrator's PIN hash directly", async () => {
      // set_member_pin refuses this; the table used not to.
      const admin = await addMember(db, shop.tenantId, { roleKey: 'tenant_admin' });
      const manager = await addMember(db, shop.tenantId, { roleKey: 'branch_manager' });
      await db.asUser(manager.userId, () =>
        db.expectDenied(
          `update tenant_memberships
              set pin_hash = extensions.crypt('5839', extensions.gen_salt('bf', 4))
            where id = $1`,
          [admin.membershipId],
        ),
      );
    });

    it("stops a manager re-pointing a stronger member's membership at themselves", async () => {
      const admin = await addMember(db, shop.tenantId, { roleKey: 'tenant_admin' });
      const manager = await addMember(db, shop.tenantId, { roleKey: 'branch_manager' });
      await db.asUser(manager.userId, () =>
        db.expectDenied(`update tenant_memberships set user_id = $1 where id = $2`, [
          manager.userId,
          admin.membershipId,
        ]),
      );
    });

    it('stops an owner attaching another business owner with a PIN they chose', async () => {
      // The cross-tenant takeover add_staff_member refuses, attempted without it.
      const other = await createTenant(db);
      await db.asUser(shop.ownerUserId, () =>
        db.expectDenied(
          `insert into tenant_memberships (tenant_id, user_id, status, accepted_at, pin_hash)
           values ($1, $2, 'ACTIVE', now(), extensions.crypt('6173', extensions.gen_salt('bf', 4)))`,
          [shop.tenantId, other.ownerUserId],
        ),
      );
    });

    it("stops an administrator stripping the owner's role", async () => {
      const admin = await addMember(db, shop.tenantId, { roleKey: 'tenant_admin' });
      await db.asUser(admin.userId, () =>
        db.expectDenied(`delete from membership_roles where membership_id = $1`, [
          shop.ownerMembershipId,
        ]),
      );
    });

    it("stops an administrator narrowing the owner's branches", async () => {
      const admin = await addMember(db, shop.tenantId, { roleKey: 'tenant_admin' });
      await db.asUser(admin.userId, () =>
        db.expectDenied(
          `insert into membership_branches (membership_id, branch_id) values ($1, $2)`,
          [shop.ownerMembershipId, shop.branchId],
        ),
      );
    });

    it('stops anyone re-ranking a role above the owner', async () => {
      // Every rank guard compares ranks; rewriting one defeats all of them at once.
      const admin = await addMember(db, shop.tenantId, { roleKey: 'tenant_admin' });
      await db.asUser(admin.userId, () =>
        db.expectDenied(`update roles set rank = 1 where tenant_id = $1 and key = 'tenant_admin'`, [
          shop.tenantId,
        ]),
      );
    });

    it("stops anyone removing permissions from the owner's role", async () => {
      const admin = await addMember(db, shop.tenantId, { roleKey: 'tenant_admin' });
      await db.asUser(admin.userId, () =>
        db.expectDenied(
          `delete from role_permissions
            where role_id = (select id from roles where tenant_id = $1 and key = 'tenant_owner')`,
          [shop.tenantId],
        ),
      );
    });

    it('still lets a manager grant a role no stronger than their own, through the function', async () => {
      const admin = await addMember(db, shop.tenantId, { roleKey: 'tenant_admin' });
      const newcomer = await addMember(db, shop.tenantId);
      await db.asUser(admin.userId, () =>
        db.query(`select set_staff_role($1, 'cashier')`, [newcomer.membershipId]),
      );
      const { rows } = await db.asServiceRole(() =>
        db.query<{ key: string }>(
          `select r.key from membership_roles mr join roles r on r.id = mr.role_id
            where mr.membership_id = $1`,
          [newcomer.membershipId],
        ),
      );
      expect(rows.map((r) => r.key)).toEqual(['cashier']);
    });

    it('still refuses a role stronger than the granter holds, through the function', async () => {
      // The rank guard the table policy used to express, now proven on the sanctioned path.
      const supervisor = await addMember(db, shop.tenantId, { roleKey: 'supervisor' });
      await db.asServiceRole(async () => {
        const role = await db.query<{ id: string }>(
          `select id from roles where tenant_id = $1 and key = 'supervisor'`,
          [shop.tenantId],
        );
        await db.query(
          `insert into role_permissions (role_id, permission_key)
           values ($1, 'roles.manage'), ($1, 'staff.manage') on conflict do nothing`,
          [role.rows[0]!.id],
        );
      });
      const newcomer = await addMember(db, shop.tenantId);
      await expect(
        db.asUser(supervisor.userId, () =>
          db.query(`select set_staff_role($1, 'tenant_admin')`, [newcomer.membershipId]),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });
  });

  describe("a business's own record", () => {
    it.each([
      [
        'extend its own trial',
        `update tenants set trial_ends_at = now() + interval '10 years' where id = $1`,
      ],
      ['rewrite its own status', `update tenants set status = 'ACTIVE' where id = $1`],
      ['take a different address', `update tenants set slug = 'taken-over-slug' where id = $1`],
      ['change its currency', `update tenants set currency_code = 'USD' where id = $1`],
      [
        'clear a suspension record',
        `update tenants set suspended_at = null, suspension_reason = null where id = $1`,
      ],
    ])('cannot %s', async (_label, sql) => {
      await db.asUser(shop.ownerUserId, () => db.expectDenied(sql, [shop.tenantId]));
    });

    it('can still edit its own business details', async () => {
      const { rows } = await db.asUser(shop.ownerUserId, () =>
        db.query(
          `update tenants
              set name = 'Renamed Shop', phone = '0200000000', receipt_footer = 'Thank you'
            where id = $1 returning id`,
          [shop.tenantId],
        ),
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe('sign-in identity', () => {
    /*
     * The account's real email, read as the harness's Auth administrator.
     *
     * Not as service_role: on real Supabase `auth.users` belongs to the Auth service and the
     * API roles have no privileges on it, and the shim matches that. The sign-in functions
     * can read it because they run as their owner; a test standing in for a person cannot.
     */
    async function accountEmail(userId: string): Promise<string> {
      const { rows } = await db.asAdmin(() =>
        db.query<{ email: string }>(`select email::text as email from auth.users where id = $1`, [
          userId,
        ]),
      );
      return rows[0]!.email;
    }

    it('stops a person changing the email their PIN sign-in resolves to', async () => {
      const cashier = await addMember(db, shop.tenantId, { roleKey: 'cashier' });
      await db.asUser(cashier.userId, () =>
        db.expectDenied(`update profiles set email = 'someone-else@example.test' where id = $1`, [
          cashier.userId,
        ]),
      );
    });

    it('still lets a person edit their own name', async () => {
      const cashier = await addMember(db, shop.tenantId, { roleKey: 'cashier' });
      const { rows } = await db.asUser(cashier.userId, () =>
        db.query(`update profiles set full_name = 'Ama Mensah' where id = $1 returning id`, [
          cashier.userId,
        ]),
      );
      expect(rows).toHaveLength(1);
    });

    it("mints a member's session for the account's own email, not the profile's", async () => {
      await db.asServiceRole(async () => {
        await db.query(
          `update tenant_memberships
              set pin_hash = extensions.crypt('4827', extensions.gen_salt('bf', 4)), pin_must_change = false
            where id = $1`,
          [shop.ownerMembershipId],
        );
        // A profile email that differs from the account's, as a past edit could have left it.
        await db.query(`update profiles set email = 'decoy-member@example.test' where id = $1`, [
          shop.ownerUserId,
        ]);
      });

      const { rows } = await db.asServiceRole(() =>
        db.query<{ status: string; email: string; user_id: string }>(
          `select out_status as status, out_email as email, out_user_id as user_id
             from verify_member_pin($1, '4827')`,
          [shop.slug],
        ),
      );
      expect(rows[0]!.status).toBe('OK');
      expect(rows[0]!.email).toBe(await accountEmail(rows[0]!.user_id));
      expect(rows[0]!.email).not.toBe('decoy-member@example.test');
    });

    it("mints the platform owner's session for the account's own email, not the profile's", async () => {
      const owner = await createUser(db, { isPlatformAdmin: true });
      await db.asServiceRole(() =>
        db.query(`update profiles set email = 'decoy-platform@example.test' where id = $1`, [
          owner,
        ]),
      );
      await db.asServiceRole(() =>
        db.query(`update platform_pin_throttle set consecutive_failures = 0, locked_until = null`),
      );

      const { rows } = await db.asServiceRole(() =>
        db.query<{ status: string; email: string; user_id: string }>(
          `select status, email, user_id from verify_platform_pin('1024')`,
        ),
      );
      expect(rows[0]!.status).toBe('OK');
      expect(rows[0]!.email).toBe(await accountEmail(rows[0]!.user_id));
      expect(rows[0]!.email).not.toBe('decoy-platform@example.test');
    });
  });
});
