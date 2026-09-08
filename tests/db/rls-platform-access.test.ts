import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { createProduct, createTenant, createUser } from '../support/fixtures.js';

/**
 * Platform administration versus tenant data.
 *
 * The obvious design gives a platform administrator access to everything. That is also how
 * a support engineer ends up able to read every shop's daily takings, silently, forever.
 *
 * Carl separates the two. `platform_admins` grants the platform — tenants, subscriptions,
 * devices, installations. Reading a customer's *business* data additionally requires a
 * `tenant_support_grants` row: named grantee, stated reason, read-only by default, and
 * expiring within seven days.
 *
 * These tests assert that separation actually holds, because it is the kind of boundary
 * that quietly erodes.
 */
describe('platform access boundaries', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.reset();
  });

  async function grantSupport(
    tenantId: string,
    granteeId: string,
    options: { write?: boolean; expired?: boolean; revoked?: boolean } = {},
  ): Promise<string> {
    const granter = await createUser(db, { isPlatformAdmin: true });
    return db.asServiceRole(async () => {
      // A grant cannot be created already expired - a CHECK requires expires_at to be
      // after granted_at. Expiry is simulated by ageing the whole grant, which is what
      // actually happens over time.
      const grantedAt = options.expired ? `now() - interval '6 hours'` : 'now()';
      const expiresAt = options.expired
        ? `now() - interval '1 hour'`
        : `now() + interval '2 hours'`;

      const { rows } = await db.query<{ id: string }>(
        `insert into tenant_support_grants
           (tenant_id, grantee_id, reason, granted_by, allow_write, granted_at, expires_at, revoked_at)
         values ($1, $2, 'Investigating a sync failure', $3, $4, ${grantedAt}, ${expiresAt}, $5)
         returning id`,
        [
          tenantId,
          granteeId,
          granter,
          options.write ?? false,
          options.revoked ? new Date().toISOString() : null,
        ],
      );
      return rows[0]!.id;
    });
  }

  it('lets a platform admin see every tenant', async () => {
    const a = await createTenant(db, { name: 'ABC Trading' });
    const b = await createTenant(db, { name: 'XYZ Stores' });
    const admin = await createUser(db, { isPlatformAdmin: true });

    const { rows } = await db.asUser(admin, () =>
      db.query<{ id: string }>(`select id from tenants`),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(a.tenantId);
    expect(ids).toContain(b.tenantId);
  });

  it('does NOT let a platform admin read a tenant’s business data without a grant', async () => {
    // The central claim of this design.
    const t = await createTenant(db);
    await createProduct(db, t.tenantId, { name: 'Confidential Product' });
    const cashier = await createUser(db);

    await db.asServiceRole(async () => {
      await db.query(
        `insert into sales (tenant_id, branch_id, sale_number, cashier_id, subtotal, total)
         values ($1, $2, 'S-1', $3, 500000, 500000)`,
        [t.tenantId, t.branchId, cashier],
      );
      await db.query(`insert into customers (tenant_id, name) values ($1, 'A Customer')`, [
        t.tenantId,
      ]);
    });

    const admin = await createUser(db, { isPlatformAdmin: true });

    await db.asUser(admin, async () => {
      for (const table of ['products', 'sales', 'customers', 'inventory', 'expenses']) {
        const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from ${table}`);
        expect(rows[0]!.n, `a platform admin read ${table} with no support grant`).toBe(0);
      }
    });
  });

  it('grants read access for the life of a support grant', async () => {
    const t = await createTenant(db);
    await createProduct(db, t.tenantId, { name: 'Visible During Support' });
    const engineer = await createUser(db, { isPlatformAdmin: true });

    const before = await db.asUser(engineer, () => db.query(`select id from products`));
    expect(before.rows).toHaveLength(0);

    await grantSupport(t.tenantId, engineer);

    const during = await db.asUser(engineer, () =>
      db.query<{ name: string }>(`select name from products`),
    );
    expect(during.rows).toHaveLength(1);
    expect(during.rows[0]!.name).toBe('Visible During Support');
  });

  it('gives no access through an expired grant', async () => {
    const t = await createTenant(db);
    await createProduct(db, t.tenantId);
    const engineer = await createUser(db, { isPlatformAdmin: true });

    await grantSupport(t.tenantId, engineer, { expired: true });

    const { rows } = await db.asUser(engineer, () => db.query(`select id from products`));
    expect(rows, 'an expired support grant still worked').toHaveLength(0);
  });

  it('gives no access through a revoked grant', async () => {
    const t = await createTenant(db);
    await createProduct(db, t.tenantId);
    const engineer = await createUser(db, { isPlatformAdmin: true });

    await grantSupport(t.tenantId, engineer, { revoked: true });

    const { rows } = await db.asUser(engineer, () => db.query(`select id from products`));
    expect(rows, 'a revoked support grant still worked').toHaveLength(0);
  });

  it('keeps a read-only grant read-only', async () => {
    const t = await createTenant(db);
    const engineer = await createUser(db, { isPlatformAdmin: true });
    await grantSupport(t.tenantId, engineer, { write: false });

    await db.asUser(engineer, () =>
      db.expectDenied(
        `insert into products (tenant_id, name, sku) values ($1, 'Support Wrote This', 'SUP-1')`,
        [t.tenantId],
      ),
    );
  });

  it('does not extend one tenant’s grant to another tenant', async () => {
    const a = await createTenant(db);
    const b = await createTenant(db);
    await createProduct(db, a.tenantId, { name: 'A Product' });
    await createProduct(db, b.tenantId, { name: 'B Product' });

    const engineer = await createUser(db, { isPlatformAdmin: true });
    await grantSupport(a.tenantId, engineer);

    const { rows } = await db.asUser(engineer, () =>
      db.query<{ name: string }>(`select name from products`),
    );
    expect(rows.map((r) => r.name)).toEqual(['A Product']);
  });

  it('does not let a non-admin use a grant issued to them', async () => {
    // Belt and braces: the grant table alone must not be a route in.
    const t = await createTenant(db);
    await createProduct(db, t.tenantId);
    const outsider = await createUser(db); // deliberately not a platform admin

    await grantSupport(t.tenantId, outsider);

    const { rows } = await db.asUser(outsider, () => db.query(`select id from products`));
    expect(rows, 'a non-admin used a support grant').toHaveLength(0);
  });

  it('shows the customer exactly who was granted access to their data', async () => {
    // The transparency that makes this mechanism worth having.
    const t = await createTenant(db);
    const engineer = await createUser(db, { isPlatformAdmin: true, fullName: 'Support Engineer' });
    await grantSupport(t.tenantId, engineer);

    const { rows } = await db.asUser(t.ownerUserId, () =>
      db.query<{ grantee_id: string; reason: string }>(
        `select grantee_id, reason from tenant_support_grants`,
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.grantee_id).toBe(engineer);
    expect(rows[0]!.reason).toBe('Investigating a sync failure');
  });

  it('stops a tenant user reading platform tables', async () => {
    const t = await createTenant(db);
    const admin = await createUser(db, { isPlatformAdmin: true });

    await db.asServiceRole(async () => {
      await db.query(
        `insert into installations (tenant_id, reference, installer_name) values ($1, 'INS-1', 'Tech')`,
        [t.tenantId],
      );
    });

    const asTenant = await db.asUser(t.ownerUserId, () => db.query(`select id from installations`));
    expect(asTenant.rows, 'a tenant user read platform installation records').toHaveLength(0);

    const asAdmin = await db.asUser(admin, () => db.query(`select id from installations`));
    expect(asAdmin.rows).toHaveLength(1);
  });

  it('lets a tenant owner see their own subscription but not another’s', async () => {
    const a = await createTenant(db);
    const b = await createTenant(db);
    const admin = await createUser(db, { isPlatformAdmin: true });

    await db.asServiceRole(async () => {
      const plan = await db.query<{ id: string }>(
        `insert into subscription_plans (key, name, price) values ('standard', 'Standard', 20000) returning id`,
      );
      for (const tenantId of [a.tenantId, b.tenantId]) {
        await db.query(
          `insert into subscriptions (tenant_id, plan_id, price, current_period_end)
           values ($1, $2, 20000, now() + interval '30 days')`,
          [tenantId, plan.rows[0]!.id],
        );
      }
    });

    const asOwner = await db.asUser(a.ownerUserId, () =>
      db.query<{ tenant_id: string }>(`select tenant_id from subscriptions`),
    );
    expect(asOwner.rows).toHaveLength(1);
    expect(asOwner.rows[0]!.tenant_id).toBe(a.tenantId);

    const asAdmin = await db.asUser(admin, () => db.query(`select tenant_id from subscriptions`));
    expect(asAdmin.rows).toHaveLength(2);
  });

  it('refuses to provision a tenant unless the caller is a platform admin', async () => {
    const ordinary = await createUser(db);

    await expect(
      db.asUser(ordinary, () =>
        db.query(
          `select * from provision_tenant('sneaky','Sneaky Ltd','x@x.test','X',$1,'Main','main','ACTIVE'::tenant_status,14)`,
          [ordinary],
        ),
      ),
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });
});
