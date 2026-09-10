import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { createTenant, addMember, type TenantFixture } from '../support/fixtures.js';

/**
 * Signing in at a till.
 *
 * The check order is the point: the device is authorised before the PIN is even looked at.
 * Reversed, this function would be a public oracle for guessing any shop's PINs — an
 * attacker would need only the endpoint, not a provisioned terminal.
 */
describe('till staff sign-in', () => {
  let db: TestDatabase;
  let shop: TenantFixture;
  let deviceId: string;
  let deviceSecret: string;
  const PEPPER = 'test-pepper-not-a-real-secret-000000000000';

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.reset();
    shop = await createTenant(db);

    deviceId = await db.asServiceRole(async () => {
      const { rows } = await db.query<{ id: string }>(
        `insert into devices (tenant_id, branch_id, code, name)
         values ($1, $2, 'till-1', 'Front till') returning id`,
        [shop.tenantId, shop.branchId],
      );
      return rows[0]!.id;
    });

    const code = await db.asUser(shop.ownerUserId, async () => {
      const { rows } = await db.query<{ code: string }>(
        `select code from issue_activation_code($1, $2, 24)`,
        [deviceId, PEPPER],
      );
      return rows[0]!.code;
    });

    deviceSecret = await db.asServiceRole(async () => {
      const { rows } = await db.query<{ device_secret: string }>(
        `select device_secret from activate_device($1, $2, $3, 'WINDOWS', '1.0.0')`,
        [code, PEPPER, `install-${randomUUID()}`],
      );
      return rows[0]!.device_secret;
    });

    // The cashier's PIN, as a manager would issue it.
    await db.asServiceRole(() =>
      db.query(
        `update tenant_memberships
            set pin_hash = extensions.crypt('4417', extensions.gen_salt('bf', 4)),
                pin_set_at = now(), pin_must_change = false
          where tenant_id = $1 and user_id = $2`,
        [shop.tenantId, shop.ownerUserId],
      ),
    );
  });

  const signIn = async (pin: string, secret = deviceSecret) => {
    const { rows } = await db.asServiceRole(() =>
      db.query<{
        out_status: string;
        out_user_id: string | null;
        out_tenant_name: string | null;
        out_branch_name: string | null;
      }>(`select * from verify_device_staff_pin($1, $2, $3, $4)`, [deviceId, secret, PEPPER, pin]),
    );
    return rows[0]!;
  };

  it('signs the cashier in with four digits and nothing else', async () => {
    const result = await signIn('4417');
    expect(result.out_status).toBe('OK');
    expect(result.out_user_id).toBe(shop.ownerUserId);
  });

  it('tells the till which shop and branch it is serving', async () => {
    // So the cashier can see, before selling anything, that the till is pointed at the
    // right counter — a misactivated terminal is otherwise invisible until the takings
    // land in the wrong branch.
    const result = await signIn('4417');
    expect(result.out_tenant_name).toBeTruthy();
    expect(result.out_branch_name).toBeTruthy();
  });

  it('rejects a wrong PIN', async () => {
    expect((await signIn('0000')).out_status).toBe('INVALID');
  });

  describe('the device is checked before the PIN', () => {
    it('refuses an unknown device secret outright', async () => {
      // Not "INVALID PIN" — the request never reaches the PIN check at all.
      await expect(signIn('4417', 'x'.repeat(64))).rejects.toThrow(
        /DEVICE|UNAUTHORIZED|PERMISSION|NOT_FOUND/i,
      );
    });

    it('refuses even a correct PIN from an unauthorised terminal', async () => {
      // The property that stops this being a public PIN oracle.
      await expect(signIn('4417', 'y'.repeat(64))).rejects.toThrow();
    });

    it('refuses a revoked terminal', async () => {
      await db.asUser(shop.ownerUserId, () =>
        db.query(`select revoke_device($1, 'Lost in transit')`, [deviceId]),
      );
      await expect(signIn('4417')).rejects.toThrow();
    });
  });

  describe('it behaves exactly as the web does', () => {
    it('refuses a suspended business before the PIN is even examined', async () => {
      /*
       * `app.authorize_device` raises TENANT_SUSPENDED, so the till is turned away at the
       * device check rather than reaching verify_member_pin and being told 'SUSPENDED'.
       *
       * That order is the better one and is left as it is: a suspended shop's terminal
       * should not be able to probe PINs at all, and no work is done on behalf of a
       * business that may not trade.
       */
      await db.asServiceRole(() =>
        db.query(
          `update tenants set status = 'SUSPENDED', suspended_at = now(),
                              suspension_reason = 'Non-payment' where id = $1`,
          [shop.tenantId],
        ),
      );
      await expect(signIn('4417')).rejects.toThrow(/TENANT_SUSPENDED/);
    });

    it('reports when the cashier must choose their own PIN', async () => {
      await db.asServiceRole(() =>
        db.query(`update tenant_memberships set pin_must_change = true where tenant_id = $1`, [
          shop.tenantId,
        ]),
      );
      const result = await signIn('4417');
      expect(result.out_status).toBe('OK');
      expect((result as unknown as { out_must_change: boolean }).out_must_change).toBe(true);
    });

    it('identifies the person, not the till', async () => {
      // Two cashiers at the same terminal must be told apart, or the ledger cannot say who
      // took the money.
      const { userId: cashier } = await addMember(db, shop.tenantId, { roleKey: 'cashier' });
      await db.asServiceRole(() =>
        db.query(
          `update tenant_memberships
              set pin_hash = extensions.crypt('8265', extensions.gen_salt('bf', 4)),
                  pin_set_at = now(), pin_must_change = false
            where tenant_id = $1 and user_id = $2`,
          [shop.tenantId, cashier],
        ),
      );

      expect((await signIn('4417')).out_user_id).toBe(shop.ownerUserId);
      expect((await signIn('8265')).out_user_id).toBe(cashier);
    });
  });

  describe('who may call it', () => {
    it('is not callable by an anonymous caller', async () => {
      await expect(
        db.asAnon(() =>
          db.query(`select * from verify_device_staff_pin($1, $2, $3, '4417')`, [
            deviceId,
            deviceSecret,
            PEPPER,
          ]),
        ),
      ).rejects.toThrow(/permission denied|does not exist/i);
    });

    it('is not callable by a signed-in member', async () => {
      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(`select * from verify_device_staff_pin($1, $2, $3, '4417')`, [
            deviceId,
            deviceSecret,
            PEPPER,
          ]),
        ),
      ).rejects.toThrow(/permission denied|does not exist/i);
    });
  });
});
