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
 * Branch scoping and role restrictions.
 *
 * Tenant isolation keeps businesses apart. These tests cover the boundaries *inside* a
 * business, which are what make Carl usable by a shop that does not want its Kumasi
 * supervisor reading Accra's takings, or its cashiers seeing what stock costs.
 */
describe('branch scoping and role restrictions', () => {
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

  describe('branch scoping', () => {
    it('confines a member assigned to one branch to that branch', async () => {
      const t = await createTenant(db);
      const kumasi = await createBranch(db, t.tenantId, 'kumasi', 'Kumasi Branch');

      const { userId } = await addMember(db, t.tenantId, {
        roleKey: 'branch_manager',
        branchIds: [kumasi],
      });

      const { rows } = await db.asUser(userId, () =>
        db.query<{ code: string }>(`select code from branches order by code`),
      );
      expect(rows.map((r) => r.code)).toEqual(['kumasi']);
    });

    it('gives a member with no branch assignment access across the tenant', async () => {
      // The default for an owner or administrator. Requiring an explicit row per branch
      // would mean every new branch silently locked out its own administrators.
      const t = await createTenant(db);
      await createBranch(db, t.tenantId, 'kumasi');
      await createBranch(db, t.tenantId, 'tema');

      const { userId } = await addMember(db, t.tenantId, { roleKey: 'tenant_admin' });

      const { rows } = await db.asUser(userId, () =>
        db.query<{ code: string }>(`select code from branches order by code`),
      );
      expect(rows.map((r) => r.code)).toEqual(['kumasi', 'main', 'tema']);
    });

    it('hides another branch’s inventory from a branch-scoped member', async () => {
      const t = await createTenant(db);
      const kumasi = await createBranch(db, t.tenantId, 'kumasi');
      const product = await createProduct(db, t.tenantId);

      await db.asServiceRole(async () => {
        for (const [branch, quantity] of [
          [t.branchId, 100],
          [kumasi, 45],
        ] as const) {
          await db.query(
            `insert into inventory (tenant_id, branch_id, product_id, quantity) values ($1, $2, $3, $4)`,
            [t.tenantId, branch, product, quantity],
          );
        }
      });

      const { userId } = await addMember(db, t.tenantId, {
        roleKey: 'branch_manager',
        branchIds: [kumasi],
      });

      const { rows } = await db.asUser(userId, () =>
        db.query<{ quantity: string }>(`select quantity from inventory`),
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.quantity)).toBe(45);
    });

    it('hides another branch’s sales from a branch-scoped supervisor', async () => {
      const t = await createTenant(db);
      const kumasi = await createBranch(db, t.tenantId, 'kumasi');
      const cashier = await createUser(db);

      await db.asServiceRole(async () => {
        await db.query(
          `insert into sales (tenant_id, branch_id, sale_number, cashier_id, subtotal, total)
           values ($1, $2, 'ACC-001', $3, 50000, 50000)`,
          [t.tenantId, t.branchId, cashier],
        );
        await db.query(
          `insert into sales (tenant_id, branch_id, sale_number, cashier_id, subtotal, total)
           values ($1, $2, 'KUM-001', $3, 30000, 30000)`,
          [t.tenantId, kumasi, cashier],
        );
      });

      const { userId } = await addMember(db, t.tenantId, {
        roleKey: 'supervisor',
        branchIds: [kumasi],
      });

      const { rows } = await db.asUser(userId, () =>
        db.query<{ sale_number: string }>(`select sale_number from sales order by sale_number`),
      );
      expect(rows.map((r) => r.sale_number)).toEqual(['KUM-001']);
    });

    it('refuses a write into a branch the member cannot access', async () => {
      const t = await createTenant(db);
      const kumasi = await createBranch(db, t.tenantId, 'kumasi');
      const { userId } = await addMember(db, t.tenantId, {
        roleKey: 'branch_manager',
        branchIds: [kumasi],
      });

      await db.asUser(userId, () =>
        db.expectDenied(
          `insert into expenses (tenant_id, branch_id, reference, description, amount, created_by)
           values ($1, $2, 'EXP-1', 'Fuel', 5000, $3)`,
          [t.tenantId, t.branchId, userId],
        ),
      );
    });
  });

  describe('role restrictions', () => {
    it('lets a cashier sell but not change prices', async () => {
      // The single most important separation in a POS: operating the till is not the same
      // authority as deciding what things cost.
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId, { retailPrice: 10000 });
      const { userId } = await addMember(db, t.tenantId, { roleKey: 'cashier' });

      const visible = await db.asUser(userId, () =>
        db.query<{ amount: string }>(`select amount from product_prices`),
      );
      expect(visible.rows).toHaveLength(1);

      await db.asUser(userId, () =>
        db.expectDenied(
          `insert into product_prices (tenant_id, product_id, tier, amount) values ($1, $2, 'RETAIL', 1)`,
          [t.tenantId, product],
        ),
      );

      await db.asUser(userId, async () => {
        const { rows } = await db.query(
          `update product_prices set amount = 1 where product_id = $1 returning id`,
          [product],
        );
        expect(rows, 'a cashier repriced a product').toHaveLength(0);
      });
    });

    it('stops a cashier creating or deleting products', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);
      const { userId } = await addMember(db, t.tenantId, { roleKey: 'cashier' });

      await db.asUser(userId, () =>
        db.expectDenied(
          `insert into products (tenant_id, name, sku) values ($1, 'Sneaky', 'SNK-1')`,
          [t.tenantId],
        ),
      );

      await db.asUser(userId, async () => {
        const { rows } = await db.query(`delete from products where id = $1 returning id`, [
          product,
        ]);
        expect(rows).toHaveLength(0);
      });
    });

    it('stops a cashier adjusting stock', async () => {
      // Direct stock writes are refused for everyone - stock moves only through a
      // transactional function that also posts a ledger entry.
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);
      const { userId } = await addMember(db, t.tenantId, { roleKey: 'cashier' });

      await db.asServiceRole(() =>
        db.query(
          `insert into inventory (tenant_id, branch_id, product_id, quantity) values ($1, $2, $3, 10)`,
          [t.tenantId, t.branchId, product],
        ),
      );

      // No UPDATE policy exists on `inventory` for any role, so the statement matches no
      // rows rather than erroring. Nothing changes, which is the guarantee that matters.
      await db.asUser(userId, () =>
        db.expectNoRowsAffected(
          `update inventory set quantity = 9999 where product_id = $1 returning id`,
          [product],
        ),
      );

      const after = await db.asServiceRole(() =>
        db.query<{ quantity: string }>(`select quantity from inventory where product_id = $1`, [
          product,
        ]),
      );
      expect(Number(after.rows[0]!.quantity)).toBe(10);
    });

    it('stops an inventory manager reading sales revenue', async () => {
      const t = await createTenant(db);
      const cashier = await createUser(db);
      await db.asServiceRole(() =>
        db.query(
          `insert into sales (tenant_id, branch_id, sale_number, cashier_id, subtotal, total)
           values ($1, $2, 'S-1', $3, 90000, 90000)`,
          [t.tenantId, t.branchId, cashier],
        ),
      );

      const { userId } = await addMember(db, t.tenantId, { roleKey: 'inventory_manager' });

      const { rows } = await db.asUser(userId, () => db.query(`select total from sales`));
      expect(rows, 'an inventory manager read sales revenue').toHaveLength(0);
    });

    it('stops an accountant creating a sale or moving stock', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);
      const { userId } = await addMember(db, t.tenantId, { roleKey: 'accountant' });

      await db.asUser(userId, async () => {
        await db.expectDenied(
          `insert into products (tenant_id, name, sku) values ($1, 'Nope', 'NOPE-1')`,
          [t.tenantId],
        );
        await db.expectDenied(
          `insert into inventory (tenant_id, branch_id, product_id, quantity) values ($1, $2, $3, 5)`,
          [t.tenantId, t.branchId, product],
        );
      });
    });

    it('shows a cashier only their own sales, and a supervisor the branch’s', async () => {
      // A cashier reprinting their own receipt is routine; browsing colleagues' takings
      // is not.
      const t = await createTenant(db);
      const cashier = await addMember(db, t.tenantId, { roleKey: 'cashier' });
      const other = await createUser(db);
      const supervisor = await addMember(db, t.tenantId, { roleKey: 'supervisor' });

      await db.asServiceRole(async () => {
        await db.query(
          `insert into sales (tenant_id, branch_id, sale_number, cashier_id, subtotal, total)
           values ($1, $2, 'MINE-1', $3, 1000, 1000)`,
          [t.tenantId, t.branchId, cashier.userId],
        );
        await db.query(
          `insert into sales (tenant_id, branch_id, sale_number, cashier_id, subtotal, total)
           values ($1, $2, 'THEIRS-1', $3, 2000, 2000)`,
          [t.tenantId, t.branchId, other],
        );
      });

      const asCashier = await db.asUser(cashier.userId, () =>
        db.query<{ sale_number: string }>(`select sale_number from sales`),
      );
      expect(asCashier.rows.map((r) => r.sale_number)).toEqual(['MINE-1']);

      const asSupervisor = await db.asUser(supervisor.userId, () =>
        db.query<{ sale_number: string }>(`select sale_number from sales order by sale_number`),
      );
      expect(asSupervisor.rows.map((r) => r.sale_number)).toEqual(['MINE-1', 'THEIRS-1']);
    });

    it('stops a member with no role reading anything at all', async () => {
      // Membership alone grants nothing. Permissions come from roles.
      const t = await createTenant(db);
      await createProduct(db, t.tenantId);
      const { userId } = await addMember(db, t.tenantId);

      await db.asUser(userId, async () => {
        expect((await db.query(`select id from products`)).rows).toHaveLength(0);
        expect((await db.query(`select id from sales`)).rows).toHaveLength(0);
        expect((await db.query(`select id from customers`)).rows).toHaveLength(0);
      });
    });
  });

  describe('privilege escalation through role granting', () => {
    it('stops a supervisor granting themselves an administrator role', async () => {
      // Role rank is what prevents this. Without it, anyone able to manage roles could
      // promote themselves to the top of the business in one insert.
      const t = await createTenant(db);
      const supervisor = await addMember(db, t.tenantId, { roleKey: 'supervisor' });

      // Give them roles.manage, which is the strongest realistic precondition.
      await db.asServiceRole(async () => {
        const role = await db.query<{ id: string }>(
          `select id from roles where tenant_id = $1 and key = 'supervisor'`,
          [t.tenantId],
        );
        await db.query(
          `insert into role_permissions (role_id, permission_key) values ($1, 'roles.manage')
           on conflict do nothing`,
          [role.rows[0]!.id],
        );
      });

      const adminRole = await db.asServiceRole(() =>
        db.query<{ id: string }>(
          `select id from roles where tenant_id = $1 and key = 'tenant_admin'`,
          [t.tenantId],
        ),
      );

      await db.asUser(supervisor.userId, () =>
        db.expectDenied(`insert into membership_roles (membership_id, role_id) values ($1, $2)`, [
          supervisor.membershipId,
          adminRole.rows[0]!.id,
        ]),
      );
    });

    it('lets a manager grant a role no stronger than their own', async () => {
      const t = await createTenant(db);
      const admin = await addMember(db, t.tenantId, { roleKey: 'tenant_admin' });
      const newStaff = await addMember(db, t.tenantId);

      const cashierRole = await db.asServiceRole(() =>
        db.query<{ id: string }>(`select id from roles where tenant_id = $1 and key = 'cashier'`, [
          t.tenantId,
        ]),
      );

      await db.asUser(admin.userId, async () => {
        const { rows } = await db.query(
          `insert into membership_roles (membership_id, role_id) values ($1, $2) returning id`,
          [newStaff.membershipId, cashierRole.rows[0]!.id],
        );
        expect(rows).toHaveLength(1);
      });
    });

    it('stops a member with no role granting any role at all', async () => {
      const t = await createTenant(db);
      const nobody = await addMember(db, t.tenantId);
      const staffRole = await db.asServiceRole(() =>
        db.query<{ id: string }>(`select id from roles where tenant_id = $1 and key = 'staff'`, [
          t.tenantId,
        ]),
      );

      await db.asUser(nobody.userId, () =>
        db.expectDenied(`insert into membership_roles (membership_id, role_id) values ($1, $2)`, [
          nobody.membershipId,
          staffRole.rows[0]!.id,
        ]),
      );
    });
  });
});
