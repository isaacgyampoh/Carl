import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { addMember, createBranch, createTenant } from '../support/fixtures.js';

/**
 * A business adds its own Windows till, and the till can only ever join that business.
 *
 * register_device creates a PENDING terminal; issue_activation_code gives it a one-time
 * code; activate_device binds a machine. The business is decided by the server at the first
 * step, never by the installed application.
 */
describe('register_device', () => {
  let db: TestDatabase;
  const PEPPER = 'test-pepper-not-a-real-secret-value-000000';

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.reset();
  });

  const register = (userId: string, branchId: string, name = 'Front counter') =>
    db.asUser(userId, () =>
      db.query<{ device_id: string; device_code: string }>(
        `select * from register_device($1, $2)`,
        [branchId, name],
      ),
    );

  it('lets the owner add tills, numbered per business', async () => {
    const t = await createTenant(db);
    const first = (await register(t.ownerUserId, t.branchId, 'Till 1')).rows[0]!;
    const second = (await register(t.ownerUserId, t.branchId, 'Till 2')).rows[0]!;
    expect(first.device_code).toBe('pos-1');
    expect(second.device_code).toBe('pos-2');

    const { rows } = await db.asServiceRole(() =>
      db.query<{
        tenant_id: string;
        branch_id: string;
        status: string;
        secret_hash: string | null;
      }>(`select tenant_id, branch_id, status, secret_hash from devices where id = $1`, [
        first.device_id,
      ]),
    );
    expect(rows[0]).toMatchObject({
      tenant_id: t.tenantId,
      branch_id: t.branchId,
      status: 'PENDING',
      secret_hash: null,
    });
  });

  it('numbers each business independently', async () => {
    const a = await createTenant(db);
    const b = await createTenant(db);
    await register(a.ownerUserId, a.branchId);
    await register(a.ownerUserId, a.branchId);
    expect((await register(b.ownerUserId, b.branchId)).rows[0]!.device_code).toBe('pos-1');
  });

  it('records who added the till', async () => {
    const t = await createTenant(db);
    const device = (await register(t.ownerUserId, t.branchId)).rows[0]!;
    const { rows } = await db.asServiceRole(() =>
      db.query<{ actor_id: string }>(
        `select actor_id from audit_logs where action = 'DEVICE_REGISTERED' and entity_id = $1`,
        [device.device_id],
      ),
    );
    expect(rows).toEqual([{ actor_id: t.ownerUserId }]);
  });

  it('refuses a cashier', async () => {
    const t = await createTenant(db);
    const cashier = await addMember(db, t.tenantId, { roleKey: 'cashier' });
    await expect(register(cashier.userId, t.branchId)).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it("refuses another business's owner at this business's branch", async () => {
    const a = await createTenant(db);
    const b = await createTenant(db);
    await expect(register(b.ownerUserId, a.branchId)).rejects.toThrow(/NOT_FOUND/);
    const { rows } = await db.asServiceRole(() =>
      db.query(`select 1 from devices where tenant_id = $1`, [a.tenantId]),
    );
    expect(rows).toHaveLength(0);
  });

  it('confines a branch-scoped administrator to their own branch', async () => {
    const t = await createTenant(db);
    const kumasi = await createBranch(db, t.tenantId, 'kumasi', 'Kumasi');
    const admin = await addMember(db, t.tenantId, { roleKey: 'tenant_admin', branchIds: [kumasi] });
    await expect(register(admin.userId, t.branchId)).rejects.toThrow(/NOT_FOUND/);
    expect((await register(admin.userId, kumasi)).rows[0]!.device_code).toBe('pos-1');
  });

  it('refuses a blank or oversized name', async () => {
    const t = await createTenant(db);
    await expect(register(t.ownerUserId, t.branchId, ' ')).rejects.toThrow(/VALIDATION_FAILED/);
    await expect(register(t.ownerUserId, t.branchId, 'x'.repeat(61))).rejects.toThrow(
      /VALIDATION_FAILED/,
    );
  });

  it('is not callable anonymously', async () => {
    const { rows } = await db.asAdmin(() =>
      db.query<{ anon: boolean }>(
        `select has_function_privilege('anon', 'register_device(uuid, text)', 'execute') as anon`,
      ),
    );
    expect(rows[0]!.anon).toBe(false);
  });

  it('activates into exactly the business and branch that registered it', async () => {
    const a = await createTenant(db);
    await createTenant(db); // a second business, which must not be where the till lands
    const device = (await register(a.ownerUserId, a.branchId)).rows[0]!;

    const code = await db.asUser(a.ownerUserId, () =>
      db.query<{ code: string }>(`select code from issue_activation_code($1, $2, 24)`, [
        device.device_id,
        PEPPER,
      ]),
    );
    const activated = await db.asServiceRole(() =>
      db.query<{ device_id: string; tenant_id: string; branch_id: string; device_secret: string }>(
        `select * from activate_device($1, $2, 'install-windows-till-1', 'WINDOWS', '0.2.0')`,
        [code.rows[0]!.code, PEPPER],
      ),
    );
    expect(activated.rows[0]).toMatchObject({
      device_id: device.device_id,
      tenant_id: a.tenantId,
      branch_id: a.branchId,
    });
    expect(activated.rows[0]!.device_secret.length).toBeGreaterThan(20);
  });
});
