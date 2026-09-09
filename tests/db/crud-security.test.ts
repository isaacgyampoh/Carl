import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { addMember, createBranch, createTenant, type TenantFixture } from '../support/fixtures.js';

/**
 * Security of the create/edit paths.
 *
 * Every mutation added for the CRUD screens goes through a database function, and each one
 * must independently re-establish: who is calling, which tenant they belong to, whether
 * they may act in the branch, and whether they hold the permission. A SECURITY DEFINER
 * function does not get RLS applied to its own writes, so anything RLS would have checked
 * has to be checked explicitly — and that is exactly the kind of thing that gets forgotten.
 *
 * These are the tests that would catch it.
 */
describe('CRUD mutation security', () => {
  let db: TestDatabase;
  let a: TenantFixture;
  let b: TenantFixture;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.reset();
    a = await createTenant(db, { name: 'Tenant A' });
    b = await createTenant(db, { name: 'Tenant B' });
  });

  describe('customers are tenant-scoped', () => {
    it('refuses to create a customer inside another tenant', async () => {
      await db.asUser(a.ownerUserId, () =>
        db.expectDenied(`insert into customers (tenant_id, name) values ($1, 'Injected')`, [
          b.tenantId,
        ]),
      );
    });

    it('shows nothing of another tenant’s customers', async () => {
      await db.asServiceRole(() =>
        db.query(
          `insert into customers (tenant_id, name, phone) values ($1, 'B Customer', '0244000009')`,
          [b.tenantId],
        ),
      );

      const { rows } = await db.asUser(a.ownerUserId, () =>
        db.query(`select id from customers where tenant_id = $1`, [b.tenantId]),
      );
      expect(rows).toHaveLength(0);
    });

    it('changes nothing when updating another tenant’s customer', async () => {
      const { rows } = await db.asServiceRole(() =>
        db.query<{ id: string }>(
          `insert into customers (tenant_id, name) values ($1, 'Original') returning id`,
          [b.tenantId],
        ),
      );
      const customerId = rows[0]!.id;

      await db.asUser(a.ownerUserId, () =>
        db.expectNoRowsAffected(
          `update customers set name = 'Vandalised' where id = $1 returning id`,
          [customerId],
        ),
      );

      const after = await db.asServiceRole(() =>
        db.query<{ name: string }>(`select name from customers where id = $1`, [customerId]),
      );
      expect(after.rows[0]!.name).toBe('Original');
    });

    it('deletes nothing belonging to another tenant', async () => {
      const { rows } = await db.asServiceRole(() =>
        db.query<{ id: string }>(
          `insert into customers (tenant_id, name) values ($1, 'Theirs') returning id`,
          [b.tenantId],
        ),
      );

      await db.asUser(a.ownerUserId, () =>
        db.expectNoRowsAffected(`delete from customers where id = $1 returning id`, [rows[0]!.id]),
      );
    });

    it('refuses to move its own customer into another tenant', async () => {
      // The attack a USING-only policy permits: take a row you own and rewrite its owner.
      const { rows } = await db.asServiceRole(() =>
        db.query<{ id: string }>(
          `insert into customers (tenant_id, name) values ($1, 'Mine') returning id`,
          [a.tenantId],
        ),
      );

      await db.asUser(a.ownerUserId, () =>
        db.expectDenied(`update customers set tenant_id = $1 where id = $2`, [
          b.tenantId,
          rows[0]!.id,
        ]),
      );
    });
  });

  describe('suppliers are tenant-scoped', () => {
    it('refuses to create a supplier inside another tenant', async () => {
      await db.asUser(a.ownerUserId, () =>
        db.expectDenied(`insert into suppliers (tenant_id, name) values ($1, 'Injected')`, [
          b.tenantId,
        ]),
      );
    });

    it('shows nothing of another tenant’s suppliers', async () => {
      await db.asServiceRole(() =>
        db.query(`insert into suppliers (tenant_id, name) values ($1, 'B Supplier')`, [b.tenantId]),
      );
      const { rows } = await db.asUser(a.ownerUserId, () => db.query(`select id from suppliers`));
      expect(rows).toHaveLength(0);
    });
  });

  describe('upsert_product', () => {
    it('refuses a caller without products.create', async () => {
      const { userId } = await addMember(db, a.tenantId, { roleKey: 'cashier' });
      await expect(
        db.asUser(userId, () =>
          db.query(`select * from upsert_product($1, 'Sneaky', 'SNK-1', 1000)`, [a.branchId]),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('refuses to create a product against another tenant’s branch', async () => {
      // The branch determines the tenant, so naming a foreign branch is the only way to
      // attempt a cross-tenant write here. It fails on the permission check.
      await expect(
        db.asUser(a.ownerUserId, () =>
          db.query(`select * from upsert_product($1, 'Injected', 'INJ-1', 1000)`, [b.branchId]),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('refuses to edit another tenant’s product', async () => {
      const { rows } = await db.asUser(b.ownerUserId, () =>
        db.query<{ product_id: string }>(
          `select * from upsert_product($1, 'Theirs', 'THEIRS-1', 5000)`,
          [b.branchId],
        ),
      );

      // A valid product id from another tenant, presented with the caller's own branch.
      await expect(
        db.asUser(a.ownerUserId, () =>
          db.query(`select * from upsert_product($1, 'Hijacked', 'HIJACK-1', 1, $2)`, [
            a.branchId,
            rows[0]!.product_id,
          ]),
        ),
      ).rejects.toThrow(/PRODUCT_NOT_FOUND/);

      const after = await db.asServiceRole(() =>
        db.query<{ name: string }>(`select name from products where id = $1`, [
          rows[0]!.product_id,
        ]),
      );
      expect(after.rows[0]!.name, 'another tenant’s product was renamed').toBe('Theirs');
    });

    it('refuses a suspended tenant', async () => {
      await db.asServiceRole(() =>
        db.query(
          `update tenants set status = 'SUSPENDED', suspended_at = now(), suspension_reason = 'Non-payment' where id = $1`,
          [a.tenantId],
        ),
      );
      await expect(
        db.asUser(a.ownerUserId, () =>
          db.query(`select * from upsert_product($1, 'Blocked', 'BLOCK-1', 1000)`, [a.branchId]),
        ),
      ).rejects.toThrow(/TENANT_SUSPENDED/);
    });

    it('writes an audit entry for both create and update', async () => {
      const { rows } = await db.asUser(a.ownerUserId, () =>
        db.query<{ product_id: string }>(
          `select * from upsert_product($1, 'Audited', 'AUD-1', 2500)`,
          [a.branchId],
        ),
      );
      await db.asUser(a.ownerUserId, () =>
        db.query(`select * from upsert_product($1, 'Audited v2', 'AUD-1', 2600, $2)`, [
          a.branchId,
          rows[0]!.product_id,
        ]),
      );

      const audit = await db.asServiceRole(() =>
        db.query<{ action: string }>(
          `select action from audit_logs where entity_id = $1 order by occurred_at`,
          [rows[0]!.product_id],
        ),
      );
      expect(audit.rows.map((r) => r.action)).toEqual(
        expect.arrayContaining(['PRODUCT_CREATED', 'PRODUCT_UPDATED']),
      );
    });
  });

  describe('create_purchase', () => {
    it('refuses a caller without purchases.create', async () => {
      const { userId } = await addMember(db, a.tenantId, { roleKey: 'cashier' });
      const product = await db.asUser(a.ownerUserId, () =>
        db.query<{ product_id: string }>(
          `select * from upsert_product($1, 'Item', 'ITEM-1', 1000)`,
          [a.branchId],
        ),
      );

      await expect(
        db.asUser(userId, () =>
          db.query(`select * from create_purchase($1, $2::jsonb)`, [
            a.branchId,
            JSON.stringify([
              { product_id: product.rows[0]!.product_id, quantity: 1, unit_cost: 500 },
            ]),
          ]),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('refuses another tenant’s supplier even though the foreign key would allow it', async () => {
      const supplier = await db.asServiceRole(() =>
        db.query<{ id: string }>(
          `insert into suppliers (tenant_id, name) values ($1, 'Their Supplier') returning id`,
          [b.tenantId],
        ),
      );
      const product = await db.asUser(a.ownerUserId, () =>
        db.query<{ product_id: string }>(
          `select * from upsert_product($1, 'Item', 'ITEM-2', 1000)`,
          [a.branchId],
        ),
      );

      await expect(
        db.asUser(a.ownerUserId, () =>
          db.query(`select * from create_purchase($1, $2::jsonb, $3)`, [
            a.branchId,
            JSON.stringify([
              { product_id: product.rows[0]!.product_id, quantity: 1, unit_cost: 500 },
            ]),
            supplier.rows[0]!.id,
          ]),
        ),
      ).rejects.toThrow(/NOT_FOUND/);
    });

    it('refuses another tenant’s product', async () => {
      const theirs = await db.asUser(b.ownerUserId, () =>
        db.query<{ product_id: string }>(
          `select * from upsert_product($1, 'Theirs', 'THEIRS-2', 1000)`,
          [b.branchId],
        ),
      );

      await expect(
        db.asUser(a.ownerUserId, () =>
          db.query(`select * from create_purchase($1, $2::jsonb)`, [
            a.branchId,
            JSON.stringify([
              { product_id: theirs.rows[0]!.product_id, quantity: 1, unit_cost: 500 },
            ]),
          ]),
        ),
      ).rejects.toThrow(/PRODUCT_NOT_FOUND/);
    });

    it('refuses a negative or zero cost', async () => {
      const product = await db.asUser(a.ownerUserId, () =>
        db.query<{ product_id: string }>(
          `select * from upsert_product($1, 'Item', 'ITEM-3', 1000)`,
          [a.branchId],
        ),
      );

      await expect(
        db.asUser(a.ownerUserId, () =>
          db.query(`select * from create_purchase($1, $2::jsonb)`, [
            a.branchId,
            JSON.stringify([
              { product_id: product.rows[0]!.product_id, quantity: 1, unit_cost: -500 },
            ]),
          ]),
        ),
      ).rejects.toThrow(/INVALID_PRICE/);
    });
  });

  describe('create_stock_transfer', () => {
    it('refuses to move stock out of a branch the caller cannot access', async () => {
      // The sharp case: a manager at one site emptying another's shelves. Every foreign key
      // is satisfied and both branches are in the right tenant — only the branch-access
      // check stops it.
      const accra = a.branchId;
      const kumasi = await createBranch(db, a.tenantId, 'kumasi');
      const { userId } = await addMember(db, a.tenantId, {
        roleKey: 'branch_manager',
        branchIds: [kumasi],
      });

      const product = await db.asUser(a.ownerUserId, () =>
        db.query<{ product_id: string }>(
          `select * from upsert_product($1, 'Item', 'ITEM-4', 1000)`,
          [accra],
        ),
      );

      await expect(
        db.asUser(userId, () =>
          db.query(`select * from create_stock_transfer($1, $2, $3::jsonb)`, [
            accra,
            kumasi,
            JSON.stringify([{ product_id: product.rows[0]!.product_id, quantity: 5 }]),
          ]),
        ),
      ).rejects.toThrow(/FORBIDDEN_BRANCH/);
    });

    it('refuses a transfer between two different tenants', async () => {
      const product = await db.asUser(a.ownerUserId, () =>
        db.query<{ product_id: string }>(
          `select * from upsert_product($1, 'Item', 'ITEM-5', 1000)`,
          [a.branchId],
        ),
      );

      await expect(
        db.asUser(a.ownerUserId, () =>
          db.query(`select * from create_stock_transfer($1, $2, $3::jsonb)`, [
            a.branchId,
            b.branchId,
            JSON.stringify([{ product_id: product.rows[0]!.product_id, quantity: 1 }]),
          ]),
        ),
      ).rejects.toThrow(/CROSS_TENANT_REFERENCE/);
    });

    it('refuses a transfer to the same branch', async () => {
      const product = await db.asUser(a.ownerUserId, () =>
        db.query<{ product_id: string }>(
          `select * from upsert_product($1, 'Item', 'ITEM-6', 1000)`,
          [a.branchId],
        ),
      );

      await expect(
        db.asUser(a.ownerUserId, () =>
          db.query(`select * from create_stock_transfer($1, $1, $2::jsonb)`, [
            a.branchId,
            JSON.stringify([{ product_id: product.rows[0]!.product_id, quantity: 1 }]),
          ]),
        ),
      ).rejects.toThrow(/VALIDATION_FAILED/);
    });

    it('refuses a caller without inventory.transfer_create', async () => {
      const kumasi = await createBranch(db, a.tenantId, 'kumasi2');
      const { userId } = await addMember(db, a.tenantId, { roleKey: 'cashier' });
      const product = await db.asUser(a.ownerUserId, () =>
        db.query<{ product_id: string }>(
          `select * from upsert_product($1, 'Item', 'ITEM-7', 1000)`,
          [a.branchId],
        ),
      );

      await expect(
        db.asUser(userId, () =>
          db.query(`select * from create_stock_transfer($1, $2, $3::jsonb)`, [
            a.branchId,
            kumasi,
            JSON.stringify([{ product_id: product.rows[0]!.product_id, quantity: 1 }]),
          ]),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });
  });
});
