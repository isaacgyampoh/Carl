import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { createBranch, createProduct, createTenant, createUser } from '../support/fixtures.js';

/**
 * Database constraints are part of Carl's security model, not a formality.
 *
 * Application validation can be bypassed — by a bug, a support script, a direct psql
 * session, or a future developer calling a table directly. These tests assert the rules
 * that survive all of that. Each one describes a mistake that would otherwise reach
 * production data.
 */
describe('schema constraints', () => {
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

  describe('tenant isolation of unique keys', () => {
    it('lets two businesses use the same branch code', async () => {
      // Global uniqueness would leak the existence of other tenants through collisions.
      const a = await createTenant(db);
      const b = await createTenant(db);
      await expect(createBranch(db, a.tenantId, 'accra')).resolves.toBeTruthy();
      await expect(createBranch(db, b.tenantId, 'accra')).resolves.toBeTruthy();
    });

    it('refuses a duplicate branch code within one business', async () => {
      const t = await createTenant(db);
      await createBranch(db, t.tenantId, 'accra');
      await expect(createBranch(db, t.tenantId, 'accra')).rejects.toThrow(/duplicate key/i);
    });

    it('lets two businesses use the same SKU', async () => {
      const a = await createTenant(db);
      const b = await createTenant(db);
      await createProduct(db, a.tenantId, { sku: 'RICE-5KG' });
      await expect(createProduct(db, b.tenantId, { sku: 'RICE-5KG' })).resolves.toBeTruthy();
    });

    it('refuses a duplicate SKU within one business', async () => {
      const t = await createTenant(db);
      await createProduct(db, t.tenantId, { sku: 'RICE-5KG' });
      await expect(createProduct(db, t.tenantId, { sku: 'RICE-5KG' })).rejects.toThrow(
        /duplicate key/i,
      );
    });

    it('refuses a barcode that would resolve to two products', async () => {
      // The POS depends on a scan being unambiguous. A duplicate would ring up the wrong
      // product with no way for the cashier to notice.
      const t = await createTenant(db);
      const first = await createProduct(db, t.tenantId);
      const second = await createProduct(db, t.tenantId);

      await db.asServiceRole(async () => {
        await db.query(
          `insert into product_barcodes (tenant_id, product_id, barcode) values ($1, $2, '5449000000996')`,
          [t.tenantId, first],
        );
        await expect(
          db.query(
            `insert into product_barcodes (tenant_id, product_id, barcode) values ($1, $2, '5449000000996')`,
            [t.tenantId, second],
          ),
        ).rejects.toThrow(/duplicate key/i);
      });
    });
  });

  describe('cross-tenant reference guards', () => {
    it('refuses to grant a membership a role belonging to another tenant', async () => {
      // Every individual foreign key here is satisfied. Only the trigger catches it —
      // and without it this is a complete authorization bypass.
      const a = await createTenant(db);
      const b = await createTenant(db);

      await db.asServiceRole(async () => {
        const role = await db.query<{ id: string }>(
          `insert into roles (tenant_id, key, name) values ($1, 'cashier', 'Cashier') returning id`,
          [b.tenantId],
        );
        await expect(
          db.query(`insert into membership_roles (membership_id, role_id) values ($1, $2)`, [
            a.ownerMembershipId,
            role.rows[0]!.id,
          ]),
        ).rejects.toThrow(/CROSS_TENANT_REFERENCE/);
      });
    });

    it('refuses to assign a member to another tenant’s branch', async () => {
      const a = await createTenant(db);
      const b = await createTenant(db);
      const foreignBranch = await createBranch(db, b.tenantId, 'kumasi');

      await db.asServiceRole(async () => {
        await expect(
          db.query(`insert into membership_branches (membership_id, branch_id) values ($1, $2)`, [
            a.ownerMembershipId,
            foreignBranch,
          ]),
        ).rejects.toThrow(/CROSS_TENANT_REFERENCE/);
      });
    });

    it('refuses to place a device in another tenant’s branch', async () => {
      const a = await createTenant(db);
      const b = await createTenant(db);

      await db.asServiceRole(async () => {
        await expect(
          db.query(
            `insert into devices (tenant_id, branch_id, code, name) values ($1, $2, 'pos-1', 'Till 1')`,
            [a.tenantId, b.branchId],
          ),
        ).rejects.toThrow(/CROSS_TENANT_REFERENCE/);
      });
    });
  });

  describe('money arithmetic', () => {
    it('refuses a sale whose parts do not add up', async () => {
      const t = await createTenant(db);
      const cashier = await createUser(db);

      await db.asServiceRole(async () => {
        await expect(
          db.query(
            `insert into sales (tenant_id, branch_id, sale_number, cashier_id, subtotal, discount_amount, tax_amount, total)
             values ($1, $2, 'S-001', $3, 10000, 1000, 0, 99999)`,
            [t.tenantId, t.branchId, cashier],
          ),
        ).rejects.toThrow(/sales_total_is_consistent/);
      });
    });

    it('accepts a sale whose parts do add up', async () => {
      const t = await createTenant(db);
      const cashier = await createUser(db);

      await db.asServiceRole(async () => {
        // 10000 - 1000 + 450 = 9450
        await expect(
          db.query(
            `insert into sales (tenant_id, branch_id, sale_number, cashier_id, subtotal, discount_amount, tax_amount, total)
             values ($1, $2, 'S-002', $3, 10000, 1000, 450, 9450)`,
            [t.tenantId, t.branchId, cashier],
          ),
        ).resolves.toBeTruthy();
      });
    });

    it('refuses to refund more than was charged', async () => {
      const t = await createTenant(db);
      const cashier = await createUser(db);

      await db.asServiceRole(async () => {
        await expect(
          db.query(
            `insert into sales (tenant_id, branch_id, sale_number, cashier_id, subtotal, total, amount_refunded)
             values ($1, $2, 'S-003', $3, 5000, 5000, 5001)`,
            [t.tenantId, t.branchId, cashier],
          ),
        ).rejects.toThrow(/sales_refund_within_total/);
      });
    });

    it('refuses a mobile money payment with no reference', async () => {
      // Carl does not integrate a Momo API; without a reference the payment cannot be
      // reconciled against the phone, so the database refuses it outright.
      const t = await createTenant(db);
      const cashier = await createUser(db);

      await db.asServiceRole(async () => {
        const sale = await db.query<{ id: string }>(
          `insert into sales (tenant_id, branch_id, sale_number, cashier_id, subtotal, total)
           values ($1, $2, 'S-004', $3, 5000, 5000) returning id`,
          [t.tenantId, t.branchId, cashier],
        );
        await expect(
          db.query(
            `insert into sale_payments (sale_id, tenant_id, branch_id, method, amount)
             values ($1, $2, $3, 'MOMO', 5000)`,
            [sale.rows[0]!.id, t.tenantId, t.branchId],
          ),
        ).rejects.toThrow(/sale_payments_reference_required/);

        // Cash needs no reference.
        await expect(
          db.query(
            `insert into sale_payments (sale_id, tenant_id, branch_id, method, amount)
             values ($1, $2, $3, 'CASH', 5000)`,
            [sale.rows[0]!.id, t.tenantId, t.branchId],
          ),
        ).resolves.toBeTruthy();
      });
    });
  });

  describe('inventory ledger', () => {
    it('refuses a movement whose direction contradicts its type', async () => {
      // A sale that increases stock, or a return that decreases it, is the single most
      // damaging inventory bug: it is invisible until stock-take.
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);

      await db.asServiceRole(async () => {
        await expect(
          db.query(
            `insert into inventory_movements (tenant_id, branch_id, product_id, movement_type, quantity, balance_after)
             values ($1, $2, $3, 'SALE', 5, 5)`,
            [t.tenantId, t.branchId, product],
          ),
        ).rejects.toThrow(/direction_matches_type/);

        await expect(
          db.query(
            `insert into inventory_movements (tenant_id, branch_id, product_id, movement_type, quantity, balance_after)
             values ($1, $2, $3, 'SALE', -5, -5)`,
            [t.tenantId, t.branchId, product],
          ),
        ).resolves.toBeTruthy();
      });
    });

    it('refuses a movement of zero, which records nothing', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);

      // STOCK_COUNT is the one type permitting either direction, so this isolates the
      // non-zero rule rather than tripping the direction check first.
      await db.asServiceRole(async () => {
        await expect(
          db.query(
            `insert into inventory_movements (tenant_id, branch_id, product_id, movement_type, quantity, balance_after)
             values ($1, $2, $3, 'STOCK_COUNT', 0, 0)`,
            [t.tenantId, t.branchId, product],
          ),
        ).rejects.toThrow(/quantity_non_zero/);
      });
    });

    it('makes the ledger immutable', async () => {
      // The ledger's entire value is that it cannot be rewritten after the fact.
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);

      await db.asServiceRole(async () => {
        const movement = await db.query<{ id: string }>(
          `insert into inventory_movements (tenant_id, branch_id, product_id, movement_type, quantity, balance_after)
           values ($1, $2, $3, 'PURCHASE', 10, 10) returning id`,
          [t.tenantId, t.branchId, product],
        );
        const id = movement.rows[0]!.id;

        await expect(
          db.query(`update inventory_movements set quantity = 999 where id = $1`, [id]),
        ).rejects.toThrow(/IMMUTABLE_RECORD/);
        await expect(
          db.query(`delete from inventory_movements where id = $1`, [id]),
        ).rejects.toThrow(/IMMUTABLE_RECORD/);
      });
    });
  });

  describe('audit log', () => {
    it('cannot be altered or deleted, even by the service role', async () => {
      // A tenant admin covering their tracks is exactly the case this protects against,
      // so it must hold for the most privileged caller there is.
      const t = await createTenant(db);

      await db.asServiceRole(async () => {
        const entry = await db.query<{ id: string }>(
          `insert into audit_logs (tenant_id, action, entity_type) values ($1, 'SALE_CREATED', 'sale') returning id`,
          [t.tenantId],
        );
        const id = entry.rows[0]!.id;

        await expect(
          db.query(`update audit_logs set action = 'NOTHING_HAPPENED' where id = $1`, [id]),
        ).rejects.toThrow(/IMMUTABLE_RECORD/);
        await expect(db.query(`delete from audit_logs where id = $1`, [id])).rejects.toThrow(
          /IMMUTABLE_RECORD/,
        );
      });
    });
  });

  describe('operational invariants', () => {
    it('allows only one default branch per tenant', async () => {
      const t = await createTenant(db);
      await db.asServiceRole(async () => {
        await expect(
          db.query(
            `insert into branches (tenant_id, code, name, is_default) values ($1, 'second', 'Second', true)`,
            [t.tenantId],
          ),
        ).rejects.toThrow(/duplicate key/i);
      });
    });

    it('allows only one open cash session per register', async () => {
      // Two open sessions on one drawer means neither reconciles.
      const t = await createTenant(db);
      const opener = await createUser(db);

      await db.asServiceRole(async () => {
        const register = await db.query<{ id: string }>(
          `insert into cash_registers (tenant_id, branch_id, name) values ($1, $2, 'Till 1') returning id`,
          [t.tenantId, t.branchId],
        );
        const registerId = register.rows[0]!.id;

        await db.query(
          `insert into cash_sessions (tenant_id, branch_id, register_id, opened_by) values ($1, $2, $3, $4)`,
          [t.tenantId, t.branchId, registerId, opener],
        );
        await expect(
          db.query(
            `insert into cash_sessions (tenant_id, branch_id, register_id, opened_by) values ($1, $2, $3, $4)`,
            [t.tenantId, t.branchId, registerId, opener],
          ),
        ).rejects.toThrow(/duplicate key/i);
      });
    });

    it('requires a suspended tenant to record why', async () => {
      // "Why is this shop locked out" must be answerable at the moment it becomes urgent.
      const t = await createTenant(db);
      await db.asServiceRole(async () => {
        await expect(
          db.query(`update tenants set status = 'SUSPENDED' where id = $1`, [t.tenantId]),
        ).rejects.toThrow(/suspension_documented/);

        await expect(
          db.query(
            `update tenants set status = 'SUSPENDED', suspended_at = now(), suspension_reason = 'Non-payment' where id = $1`,
            [t.tenantId],
          ),
        ).resolves.toBeTruthy();
      });
    });

    it('refuses an active device that has no credential', async () => {
      const t = await createTenant(db);
      await db.asServiceRole(async () => {
        await expect(
          db.query(
            `insert into devices (tenant_id, branch_id, code, name, status) values ($1, $2, 'pos-1', 'Till 1', 'ACTIVE')`,
            [t.tenantId, t.branchId],
          ),
        ).rejects.toThrow(/devices_active_is_activated/);
      });
    });

    it('refuses an activation code with a window longer than 48 hours', async () => {
      // A long-lived bearer credential is not a short-lived one.
      const t = await createTenant(db);
      await db.asServiceRole(async () => {
        const device = await db.query<{ id: string }>(
          `insert into devices (tenant_id, branch_id, code, name) values ($1, $2, 'pos-1', 'Till 1') returning id`,
          [t.tenantId, t.branchId],
        );
        await expect(
          db.query(
            `insert into device_activations (tenant_id, device_id, code_hash, code_hint, expires_at)
             values ($1, $2, '\\x00'::bytea, 'AB12', now() + interval '30 days')`,
            [t.tenantId, device.rows[0]!.id],
          ),
        ).rejects.toThrow(/window_bounded/);
      });
    });

    it('allows only one live activation code per device', async () => {
      const t = await createTenant(db);
      await db.asServiceRole(async () => {
        const device = await db.query<{ id: string }>(
          `insert into devices (tenant_id, branch_id, code, name) values ($1, $2, 'pos-2', 'Till 2') returning id`,
          [t.tenantId, t.branchId],
        );
        const deviceId = device.rows[0]!.id;
        await db.query(
          `insert into device_activations (tenant_id, device_id, code_hash, code_hint, expires_at)
           values ($1, $2, '\\x01'::bytea, 'AB12', now() + interval '2 hours')`,
          [t.tenantId, deviceId],
        );
        await expect(
          db.query(
            `insert into device_activations (tenant_id, device_id, code_hash, code_hint, expires_at)
             values ($1, $2, '\\x02'::bytea, 'CD34', now() + interval '2 hours')`,
            [t.tenantId, deviceId],
          ),
        ).rejects.toThrow(/duplicate key/i);
      });
    });

    it('bounds a support grant to seven days', async () => {
      // Support access measured in weeks is standing access with extra steps.
      const t = await createTenant(db);
      const staff = await createUser(db, { isPlatformAdmin: true });
      const granter = await createUser(db, { isPlatformAdmin: true });

      await db.asServiceRole(async () => {
        await expect(
          db.query(
            `insert into tenant_support_grants (tenant_id, grantee_id, reason, granted_by, expires_at)
             values ($1, $2, 'Investigating sync failure', $3, now() + interval '30 days')`,
            [t.tenantId, staff, granter],
          ),
        ).rejects.toThrow(/window_bounded/);
      });
    });
  });
});
