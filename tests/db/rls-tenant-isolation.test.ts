import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import {
  addMember,
  createBranch,
  createProduct,
  createTenant,
  createUser,
} from '../support/fixtures.js';

/**
 * Tenant isolation.
 *
 * This is the suite that matters most. Carl is a multi-tenant SaaS: if one business can
 * read another's sales, stock or customers, nothing else about the product is worth
 * discussing.
 *
 * Every test here runs as a real `authenticated` PostgreSQL role with real JWT claims
 * against real policies. Nothing is mocked.
 *
 * Note the two distinct failure shapes, which are easy to conflate and which mean very
 * different things:
 *
 *   READS  are filtered — a forbidden row returns as zero rows, not an error.
 *   WRITES are refused — SQLSTATE 42501.
 *
 * A test asserting `toThrow()` on a forbidden SELECT would fail even with isolation
 * working perfectly, so read tests assert emptiness.
 */
describe('tenant isolation', () => {
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

  describe('SELECT across tenants', () => {
    it('shows a member only their own tenant', async () => {
      const a = await createTenant(db, { name: 'ABC Trading' });
      const b = await createTenant(db, { name: 'XYZ Stores' });

      const visible = await db.asUser(a.ownerUserId, () =>
        db.query<{ id: string; name: string }>(`select id, name from tenants order by name`),
      );

      expect(visible.rows).toHaveLength(1);
      expect(visible.rows[0]!.name).toBe('ABC Trading');
      expect(visible.rows.map((r) => r.id)).not.toContain(b.tenantId);
    });

    it('hides another tenant even when its id is known and named explicitly', async () => {
      // The realistic attack: the id is not secret. Guessing it must gain nothing.
      const a = await createTenant(db);
      const b = await createTenant(db);

      const result = await db.asUser(a.ownerUserId, () =>
        db.query(`select * from tenants where id = $1`, [b.tenantId]),
      );
      expect(result.rows).toHaveLength(0);
    });

    it('hides another tenant’s branches, products, customers and suppliers', async () => {
      const a = await createTenant(db);
      const b = await createTenant(db);
      await createBranch(db, b.tenantId, 'kumasi');
      await createProduct(db, b.tenantId, { name: 'Secret Product' });

      await db.asServiceRole(async () => {
        await db.query(
          `insert into customers (tenant_id, name, phone) values ($1, 'B Customer', '0244000001')`,
          [b.tenantId],
        );
        await db.query(`insert into suppliers (tenant_id, name) values ($1, 'B Supplier')`, [
          b.tenantId,
        ]);
      });

      await db.asUser(a.ownerUserId, async () => {
        for (const table of ['branches', 'products', 'customers', 'suppliers']) {
          const { rows } = await db.query<{ n: number }>(
            `select count(*)::int as n from ${table} where tenant_id = $1`,
            [b.tenantId],
          );
          expect(rows[0]!.n, `${table} leaked across tenants`).toBe(0);
        }
      });
    });

    it('hides another tenant’s sales, payments and inventory movements', async () => {
      const a = await createTenant(db);
      const b = await createTenant(db);
      const product = await createProduct(db, b.tenantId);
      const cashier = await createUser(db);

      await db.asServiceRole(async () => {
        const sale = await db.query<{ id: string }>(
          `insert into sales (tenant_id, branch_id, sale_number, cashier_id, subtotal, total)
           values ($1, $2, 'S-001', $3, 25000, 25000) returning id`,
          [b.tenantId, b.branchId, cashier],
        );
        await db.query(
          `insert into sale_payments (sale_id, tenant_id, branch_id, method, amount)
           values ($1, $2, $3, 'CASH', 25000)`,
          [sale.rows[0]!.id, b.tenantId, b.branchId],
        );
        await db.query(
          `insert into inventory_movements (tenant_id, branch_id, product_id, movement_type, quantity, balance_after)
           values ($1, $2, $3, 'PURCHASE', 100, 100)`,
          [b.tenantId, b.branchId, product],
        );
      });

      await db.asUser(a.ownerUserId, async () => {
        for (const table of ['sales', 'sale_payments', 'inventory_movements']) {
          const { rows } = await db.query<{ n: number }>(
            `select count(*)::int as n from ${table} where tenant_id = $1`,
            [b.tenantId],
          );
          expect(rows[0]!.n, `${table} leaked across tenants`).toBe(0);
        }
      });
    });

    it('leaks nothing through an unqualified SELECT *', async () => {
      // The lazy query is the one that gets written. It must be safe by default.
      const a = await createTenant(db);
      const b = await createTenant(db);
      await createProduct(db, a.tenantId, { name: 'Mine' });
      await createProduct(db, b.tenantId, { name: 'Theirs' });

      const { rows } = await db.asUser(a.ownerUserId, () =>
        db.query<{ name: string }>(`select name from products`),
      );
      expect(rows.map((r) => r.name)).toEqual(['Mine']);
    });

    it('leaks nothing through a join', async () => {
      // Joining an unprotected-looking table to a protected one must not widen access.
      const a = await createTenant(db);
      const b = await createTenant(db);
      await createProduct(db, b.tenantId, { name: 'Theirs' });

      const { rows } = await db.asUser(a.ownerUserId, () =>
        db.query(
          `select p.name, t.name as tenant
           from products p join tenants t on t.id = p.tenant_id`,
        ),
      );
      expect(rows).toHaveLength(0);
    });

    it('leaks nothing through an aggregate', async () => {
      // COUNT and SUM are as much a disclosure as SELECT: knowing a competitor's daily
      // takings does not require seeing individual rows.
      const a = await createTenant(db);
      const b = await createTenant(db);
      const cashier = await createUser(db);

      await db.asServiceRole(() =>
        db.query(
          `insert into sales (tenant_id, branch_id, sale_number, cashier_id, subtotal, total)
           values ($1, $2, 'S-100', $3, 999900, 999900)`,
          [b.tenantId, b.branchId, cashier],
        ),
      );

      const { rows } = await db.asUser(a.ownerUserId, () =>
        db.query<{ total: string | null; n: number }>(
          `select sum(total) as total, count(*)::int as n from sales`,
        ),
      );
      expect(rows[0]!.n).toBe(0);
      expect(rows[0]!.total).toBeNull();
    });
  });

  describe('INSERT across tenants', () => {
    it('refuses to create a product inside another tenant', async () => {
      const a = await createTenant(db);
      const b = await createTenant(db);

      await db.asUser(a.ownerUserId, () =>
        db.expectDenied(
          `insert into products (tenant_id, name, sku) values ($1, 'Injected', 'INJ-1')`,
          [b.tenantId],
        ),
      );
    });

    it('refuses to create a branch, customer or supplier inside another tenant', async () => {
      const a = await createTenant(db);
      const b = await createTenant(db);

      await db.asUser(a.ownerUserId, async () => {
        await db.expectDenied(
          `insert into branches (tenant_id, code, name) values ($1, 'injected', 'Injected')`,
          [b.tenantId],
        );
        await db.expectDenied(`insert into customers (tenant_id, name) values ($1, 'Injected')`, [
          b.tenantId,
        ]);
        await db.expectDenied(`insert into suppliers (tenant_id, name) values ($1, 'Injected')`, [
          b.tenantId,
        ]);
      });
    });

    it('refuses to add itself as a member of another tenant', async () => {
      // The most direct escalation attempt there is.
      const a = await createTenant(db);
      const b = await createTenant(db);

      await db.asUser(a.ownerUserId, () =>
        db.expectDenied(
          `insert into tenant_memberships (tenant_id, user_id, status, accepted_at)
           values ($1, $2, 'ACTIVE', now())`,
          [b.tenantId, a.ownerUserId],
        ),
      );
    });
  });

  describe('UPDATE across tenants', () => {
    it('changes nothing when updating another tenant’s rows', async () => {
      const a = await createTenant(db);
      const b = await createTenant(db);
      const product = await createProduct(db, b.tenantId, { name: 'Original' });

      await db.asUser(a.ownerUserId, async () => {
        const { rows } = await db.query(
          `update products set name = 'Vandalised' where id = $1 returning id`,
          [product],
        );
        expect(rows).toHaveLength(0);
      });

      const after = await db.asServiceRole(() =>
        db.query<{ name: string }>(`select name from products where id = $1`, [product]),
      );
      expect(after.rows[0]!.name).toBe('Original');
    });

    it('refuses to move its own row into another tenant', async () => {
      // A policy with USING but no WITH CHECK permits exactly this: take a row you own,
      // rewrite its tenant_id, and it lands in someone else's business.
      const a = await createTenant(db);
      const b = await createTenant(db);
      const product = await createProduct(db, a.tenantId);

      await db.asUser(a.ownerUserId, () =>
        db.expectDenied(`update products set tenant_id = $1 where id = $2`, [b.tenantId, product]),
      );
    });

    it('refuses to grant itself platform administration', async () => {
      // Platform administration deliberately lives in its own table, so there is no
      // privilege column on the profile row a user controls. The only route left is
      // inserting into platform_admins directly, and there is no INSERT policy for it.
      const a = await createTenant(db);

      await db.asUser(a.ownerUserId, () =>
        db.expectDenied(`insert into platform_admins (user_id) values ($1)`, [a.ownerUserId]),
      );

      const after = await db.asServiceRole(() =>
        db.query(`select user_id from platform_admins where user_id = $1`, [a.ownerUserId]),
      );
      expect(after.rows).toHaveLength(0);
    });

    it('lets a user edit their own profile, with no recursion', async () => {
      // The earlier design protected a privilege column with a policy that read its own
      // table. PostgreSQL rejects that as infinite recursion - which would have broken
      // this ordinary, legitimate update as well.
      const a = await createTenant(db);

      await db.asUser(a.ownerUserId, async () => {
        const { rows } = await db.query(
          `update profiles set full_name = 'Renamed' where id = $1 returning full_name`,
          [a.ownerUserId],
        );
        expect(rows).toHaveLength(1);
      });
    });

    it('shows a user only their own platform_admins row', async () => {
      const admin = await createUser(db, { isPlatformAdmin: true });
      const ordinary = await createUser(db);

      const asAdmin = await db.asUser(admin, () => db.query(`select user_id from platform_admins`));
      expect(asAdmin.rows).toHaveLength(1);

      const asOrdinary = await db.asUser(ordinary, () =>
        db.query(`select user_id from platform_admins`),
      );
      expect(asOrdinary.rows).toHaveLength(0);
    });
  });

  describe('DELETE across tenants', () => {
    it('deletes nothing belonging to another tenant', async () => {
      const a = await createTenant(db);
      const b = await createTenant(db);
      const product = await createProduct(db, b.tenantId);

      await db.asUser(a.ownerUserId, async () => {
        const { rows } = await db.query(`delete from products where id = $1 returning id`, [
          product,
        ]);
        expect(rows).toHaveLength(0);
      });

      const survives = await db.asServiceRole(() =>
        db.query(`select id from products where id = $1`, [product]),
      );
      expect(survives.rows).toHaveLength(1);
    });
  });

  describe('anonymous access', () => {
    it('reaches nothing at all', async () => {
      const a = await createTenant(db);
      await createProduct(db, a.tenantId);

      await db.asAnon(async () => {
        for (const table of ['tenants', 'branches', 'products', 'sales', 'customers', 'profiles']) {
          await db.expectDenied(`select * from ${table}`);
        }
      });
    });
  });

  describe('membership status', () => {
    it('gives an invited but not-yet-active member nothing', async () => {
      const a = await createTenant(db);
      const invitee = await createUser(db);

      await db.asServiceRole(() =>
        db.query(
          `insert into tenant_memberships (tenant_id, user_id, status) values ($1, $2, 'INVITED')`,
          [a.tenantId, invitee],
        ),
      );

      const { rows } = await db.asUser(invitee, () => db.query(`select id from tenants`));
      expect(rows).toHaveLength(0);
    });

    it('cuts off a removed member immediately', async () => {
      // Offboarding must take effect on the next request, not at the next login.
      const a = await createTenant(db);
      const { userId, membershipId } = await addMember(db, a.tenantId, { roleKey: 'tenant_admin' });

      const before = await db.asUser(userId, () => db.query(`select id from tenants`));
      expect(before.rows).toHaveLength(1);

      await db.asServiceRole(() =>
        db.query(
          `update tenant_memberships set status = 'REMOVED', removed_at = now() where id = $1`,
          [membershipId],
        ),
      );

      const after = await db.asUser(userId, () => db.query(`select id from tenants`));
      expect(after.rows).toHaveLength(0);
    });

    it('cuts off a suspended member immediately', async () => {
      const a = await createTenant(db);
      const { userId, membershipId } = await addMember(db, a.tenantId, { roleKey: 'cashier' });

      await db.asServiceRole(() =>
        db.query(`update tenant_memberships set status = 'SUSPENDED' where id = $1`, [
          membershipId,
        ]),
      );

      const { rows } = await db.asUser(userId, () => db.query(`select id from tenants`));
      expect(rows).toHaveLength(0);
    });
  });

  describe('tenant standing', () => {
    it('lets a suspended tenant still read its own records', async () => {
      // A business locked out for non-payment must still see its own data. Withholding it
      // is hostile, and for tax records legally fraught.
      const a = await createTenant(db);
      await createProduct(db, a.tenantId, { name: 'Still Visible' });

      await db.asServiceRole(() =>
        db.query(
          `update tenants set status = 'SUSPENDED', suspended_at = now(), suspension_reason = 'Non-payment' where id = $1`,
          [a.tenantId],
        ),
      );

      const { rows } = await db.asUser(a.ownerUserId, () =>
        db.query<{ name: string }>(`select name from products`),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.name).toBe('Still Visible');
    });

    it('stops a suspended tenant from writing', async () => {
      const a = await createTenant(db);

      await db.asServiceRole(() =>
        db.query(
          `update tenants set status = 'SUSPENDED', suspended_at = now(), suspension_reason = 'Non-payment' where id = $1`,
          [a.tenantId],
        ),
      );

      await db.asUser(a.ownerUserId, () =>
        db.expectDenied(`insert into products (tenant_id, name, sku) values ($1, 'New', 'NEW-1')`, [
          a.tenantId,
        ]),
      );
    });

    it('lets a tenant in its grace period keep trading', async () => {
      // A payment a few days late must not close the shop mid-morning.
      const a = await createTenant(db, { status: 'GRACE_PERIOD' });

      await db.asUser(a.ownerUserId, async () => {
        const { rows } = await db.query(
          `insert into products (tenant_id, name, sku) values ($1, 'Grace Product', 'GRACE-1') returning id`,
          [a.tenantId],
        );
        expect(rows).toHaveLength(1);
      });
    });
  });
});
