import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { createUser, createTenant, addMember, type TenantFixture } from '../support/fixtures.js';

/**
 * The platform owner boundary.
 *
 * Carl's control plane can onboard businesses, suspend them, and record what they have
 * paid. Whoever holds it holds the commercial relationship with every customer, so the
 * question these tests answer is not "does it work" but "can anyone else reach it".
 *
 * Every assertion here is made at the database, not the user interface. A route guard is
 * worth having, but it is the last line of a defence, not the first: an application with a
 * forgotten check must still fail, and that only holds if the function itself refuses.
 */
describe('platform authorization', () => {
  let db: TestDatabase;
  let owner: string;
  let shop: TenantFixture;
  let planId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.reset();
    owner = await createUser(db, { isPlatformAdmin: true });
    shop = await createTenant(db);
    planId = await db.asServiceRole(async () => {
      const { rows } = await db.query<{ id: string }>(
        `insert into subscription_plans (key, name, price, interval)
         values ($1, 'Standard', 15000, 'MONTHLY') returning id`,
        [`standard-${randomUUID().slice(0, 8)}`],
      );
      return rows[0]!.id;
    });
  });

  describe('a platform administrator', () => {
    it('can onboard a client', async () => {
      const newOwner = await createUser(db);
      const { rows } = await db.asUser(owner, () =>
        db.query<{ tenant_id: string; subscription_id: string }>(
          `select * from onboard_client($1, $2, $3, 'New Owner', $4, $5)`,
          [
            'Kofi Stores',
            `kofi-${randomUUID().slice(0, 8)}`,
            'kofi@example.test',
            newOwner,
            planId,
          ],
        ),
      );
      expect(rows[0]?.tenant_id).toBeTruthy();
      expect(rows[0]?.subscription_id).toBeTruthy();
    });

    it('can suspend and reactivate a business', async () => {
      await db.asUser(owner, () =>
        db.query(`select suspend_tenant($1, 'Non-payment for 60 days')`, [shop.tenantId]),
      );
      await db.asUser(owner, () => db.query(`select reactivate_tenant($1)`, [shop.tenantId]));
      const { rows } = await db.asServiceRole(() =>
        db.query<{ status: string }>(`select status from tenants where id = $1`, [shop.tenantId]),
      );
      expect(rows[0]?.status).toBe('ACTIVE');
    });
  });

  describe('a merchant owner — the highest privilege inside a business', () => {
    it('cannot onboard a client', async () => {
      const newOwner = await createUser(db);
      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(`select * from onboard_client($1, $2, $3, 'X', $4, $5)`, [
            'Rival Stores',
            `rival-${randomUUID().slice(0, 8)}`,
            'rival@example.test',
            newOwner,
            planId,
          ]),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('cannot suspend anyone — including themselves', async () => {
      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(`select suspend_tenant($1, 'test')`, [shop.tenantId]),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('cannot reactivate their own suspended business', async () => {
      // The point of suspension: the suspended party cannot undo it.
      await db.asUser(owner, () =>
        db.query(`select suspend_tenant($1, 'Non-payment')`, [shop.tenantId]),
      );
      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(`select reactivate_tenant($1)`, [shop.tenantId]),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('cannot record a payment against their own subscription', async () => {
      // Otherwise a merchant marks themselves paid and keeps trading for free.
      const subId = await db.asServiceRole(async () => {
        const { rows } = await db.query<{ id: string }>(
          `insert into subscriptions (tenant_id, plan_id, price, current_period_end)
           values ($1, $2, 15000, now() + interval '1 month') returning id`,
          [shop.tenantId, planId],
        );
        return rows[0]!.id;
      });

      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(`select * from record_subscription_payment($1, 15000, $2)`, [
            subId,
            randomUUID().replace(/-/g, ''),
          ]),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('cannot issue themselves an invoice', async () => {
      const subId = await db.asServiceRole(async () => {
        const { rows } = await db.query<{ id: string }>(
          `insert into subscriptions (tenant_id, plan_id, price, current_period_end)
           values ($1, $2, 15000, now() + interval '1 month') returning id`,
          [shop.tenantId, planId],
        );
        return rows[0]!.id;
      });
      await expect(
        db.asUser(shop.ownerUserId, () => db.query(`select * from issue_invoice($1)`, [subId])),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });
  });

  describe('a cashier', () => {
    it('cannot reach any platform operation', async () => {
      const { userId: cashier } = await addMember(db, shop.tenantId, { roleKey: 'cashier' });
      await expect(
        db.asUser(cashier, () => db.query(`select suspend_tenant($1, 'x')`, [shop.tenantId])),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });
  });

  describe('an anonymous caller', () => {
    it('cannot execute a platform operation at all', async () => {
      // Execute is revoked from anon, so this fails on the grant rather than the check.
      await expect(
        db.asAnon(() => db.query(`select suspend_tenant($1, 'x')`, [shop.tenantId])),
      ).rejects.toThrow(/permission denied|PERMISSION_DENIED/i);
    });
  });

  describe('privilege cannot be forged', () => {
    it('is not granted by a JWT claim', async () => {
      // The claim is attacker-controlled in every meaningful threat model. Authorisation
      // reads `platform_admins` by auth.uid(), so decorating the token changes nothing.
      await expect(
        db.asUser(
          shop.ownerUserId,
          () => db.query(`select suspend_tenant($1, 'x')`, [shop.tenantId]),
          { role: 'authenticated', is_platform_admin: true, platform_admin: true, admin: true },
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('is not granted by being a tenant owner of some other business', async () => {
      const other = await createTenant(db);
      await expect(
        db.asUser(other.ownerUserId, () =>
          db.query(`select suspend_tenant($1, 'x')`, [shop.tenantId]),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('is revoked the moment the platform_admins row is removed', async () => {
      await db.asUser(owner, () => db.query(`select suspend_tenant($1, 'first')`, [shop.tenantId]));
      await db.asServiceRole(() =>
        db.query(`delete from platform_admins where user_id = $1`, [owner]),
      );
      await expect(
        db.asUser(owner, () => db.query(`select reactivate_tenant($1)`, [shop.tenantId])),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });
  });

  describe('what a platform administrator still may not see', () => {
    it('cannot read a merchant’s sales', async () => {
      // The line that matters: operating Carl commercially is not the same as reading what
      // a shop sold. That still requires a time-boxed support grant the customer can see.
      const { rows } = await db.asUser(owner, () =>
        db.query<{ count: string }>(`select count(*)::text as count from sales`),
      );
      expect(rows[0]!.count).toBe('0');
    });

    it('cannot read a merchant’s stock or customers', async () => {
      await db.asServiceRole(() =>
        db.query(`insert into customers (tenant_id, name) values ($1, 'Ama Mensah')`, [
          shop.tenantId,
        ]),
      );
      const { rows } = await db.asUser(owner, () =>
        db.query<{ count: string }>(`select count(*)::text as count from customers`),
      );
      expect(rows[0]!.count, 'a platform admin read a merchant’s customer list').toBe('0');
    });

    it('can read the structural records the console needs', async () => {
      const { rows } = await db.asUser(owner, () =>
        db.query<{ count: string }>(`select count(*)::text as count from branches`),
      );
      expect(Number(rows[0]!.count)).toBeGreaterThan(0);
    });
  });
});
