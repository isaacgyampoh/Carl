import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { createTenant, addMember, type TenantFixture } from '../support/fixtures.js';

/**
 * Staff PINs.
 *
 * Four digits open a shop's till, so the throttle and the per-person attribution are the
 * two properties that matter. The second is the reason this exists at all: a single shared
 * PIN would make every sale in a shop look like the same person rang it up.
 */
describe('staff PINs', () => {
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

  /** Sets a PIN directly, standing in for the owner's onboarding or a manager issuing one. */
  async function givePin(userId: string, pin: string, mustChange = true): Promise<void> {
    await db.asServiceRole(() =>
      db.query(
        `update tenant_memberships
            set pin_hash = extensions.crypt($2, extensions.gen_salt('bf', 4)),
                pin_set_at = now(), pin_must_change = $3
          where tenant_id = $1 and user_id = $4`,
        [shop.tenantId, pin, mustChange, userId],
      ),
    );
  }

  async function verify(slug: string, pin: string) {
    const { rows } = await db.asServiceRole(() =>
      db.query<{
        status: string;
        user_id: string | null;
        tenant_id: string | null;
        must_change: boolean | null;
      }>(
        `select out_status as status, out_user_id as user_id,
                out_tenant_id as tenant_id, out_must_change as must_change
           from verify_member_pin($1, $2)`,
        [slug, pin],
      ),
    );
    return rows[0]!;
  }

  const slug = async () =>
    (
      await db.asServiceRole(() =>
        db.query<{ slug: string }>(`select slug from tenants where id = $1`, [shop.tenantId]),
      )
    ).rows[0]!.slug;

  describe('signing in', () => {
    it('identifies the person, not just the business', async () => {
      // The property the whole design exists for.
      const { userId: cashier } = await addMember(db, shop.tenantId, { roleKey: 'cashier' });
      await givePin(shop.ownerUserId, '4417');
      await givePin(cashier, '8265');

      expect((await verify(await slug(), '4417')).user_id).toBe(shop.ownerUserId);
      expect((await verify(await slug(), '8265')).user_id).toBe(cashier);
    });

    it('rejects a wrong PIN without naming anybody', async () => {
      await givePin(shop.ownerUserId, '4417');
      const result = await verify(await slug(), '0000');
      expect(result.status).toBe('INVALID');
      expect(result.user_id).toBeNull();
    });

    it('gives the same answer for a business that does not exist', async () => {
      // Otherwise the response tells an attacker which businesses are on Carl.
      const unknown = await verify('no-such-business', '4417');
      expect(unknown.status).toBe('INVALID');
      expect(unknown.tenant_id).toBeNull();
    });

    it('refuses a suspended business', async () => {
      await givePin(shop.ownerUserId, '4417');
      await db.asServiceRole(() =>
        db.query(
          `update tenants set status = 'SUSPENDED', suspended_at = now(),
                              suspension_reason = 'Non-payment' where id = $1`,
          [shop.tenantId],
        ),
      );
      expect((await verify(await slug(), '4417')).status).toBe('SUSPENDED');
    });

    it('does not let a former member back in', async () => {
      const { userId: leaver } = await addMember(db, shop.tenantId, { roleKey: 'cashier' });
      await givePin(leaver, '5150');
      await db.asServiceRole(() =>
        db.query(`update tenant_memberships set status = 'REMOVED' where user_id = $1`, [leaver]),
      );
      expect((await verify(await slug(), '5150')).status).toBe('INVALID');
    });

    it('says when the holder must choose their own PIN', async () => {
      await givePin(shop.ownerUserId, '4417', true);
      expect((await verify(await slug(), '4417')).must_change).toBe(true);
    });
  });

  describe('the throttle', () => {
    it('locks a business after repeated wrong guesses', async () => {
      await givePin(shop.ownerUserId, '4417');
      const s = await slug();
      for (let i = 0; i < 5; i += 1) {
        expect((await verify(s, '0000')).status).toBe('INVALID');
      }
      expect((await verify(s, '0001')).status).toBe('LOCKED');
    });

    it('refuses a correct PIN while locked', async () => {
      await givePin(shop.ownerUserId, '4417');
      const s = await slug();
      for (let i = 0; i < 6; i += 1) await verify(s, '0000');
      expect((await verify(s, '4417')).status).toBe('LOCKED');
    });

    it('does not lock other businesses', async () => {
      /*
       * Per-tenant on purpose. A global counter would let one attacker guessing at one shop
       * stop every other shop on Carl from trading, turning a nuisance into an outage
       * across the whole customer base.
       */
      const other = await createTenant(db);
      await givePin(shop.ownerUserId, '4417');
      await db.asServiceRole(() =>
        db.query(
          `update tenant_memberships
              set pin_hash = extensions.crypt('9182', extensions.gen_salt('bf', 4)),
                  pin_set_at = now()
            where tenant_id = $1 and user_id = $2`,
          [other.tenantId, other.ownerUserId],
        ),
      );
      const otherSlug = (
        await db.asServiceRole(() =>
          db.query<{ slug: string }>(`select slug from tenants where id = $1`, [other.tenantId]),
        )
      ).rows[0]!.slug;

      const s = await slug();
      for (let i = 0; i < 6; i += 1) await verify(s, '0000');
      expect((await verify(s, '4417')).status).toBe('LOCKED');
      expect(
        (await verify(otherSlug, '9182')).status,
        'one shop being attacked locked out another',
      ).toBe('OK');
    });

    it('survives its row going missing', async () => {
      await givePin(shop.ownerUserId, '4417');
      await db.asServiceRole(() => db.query(`delete from tenant_pin_throttle`));
      const s = await slug();
      for (let i = 0; i < 5; i += 1) await verify(s, '0000');
      expect((await verify(s, '0001')).status).toBe('LOCKED');
    });
  });

  describe('who may attempt a PIN', () => {
    it('is not callable by an anonymous visitor', async () => {
      await expect(
        db.asAnon(() => db.query(`select * from verify_member_pin('x', '1111')`)),
      ).rejects.toThrow(/permission denied|does not exist/i);
    });

    it('is not callable by a signed-in member', async () => {
      await expect(
        db.asUser(shop.ownerUserId, () => db.query(`select * from verify_member_pin('x', '1111')`)),
      ).rejects.toThrow(/permission denied|does not exist/i);
    });
  });

  describe('two people cannot share a PIN', () => {
    it('refuses a PIN already used in the same business', async () => {
      // With one credential opening two identities, the ledger would attribute a sale to
      // whichever row was scanned first — the exact failure this design avoids.
      const { userId: cashier, membershipId } = await addMember(db, shop.tenantId, {
        roleKey: 'cashier',
      });
      await givePin(shop.ownerUserId, '4417', false);
      void cashier;

      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(`select set_member_pin($1, '4417')`, [membershipId]),
        ),
      ).rejects.toThrow(/PIN_TAKEN/);
    });

    it('allows the same PIN in a different business', async () => {
      // Different shops are different keyspaces; forcing global uniqueness would leak that
      // a PIN is in use somewhere on Carl.
      const other = await createTenant(db);
      await givePin(shop.ownerUserId, '4417', false);
      const otherMembership = (
        await db.asServiceRole(() =>
          db.query<{ id: string }>(
            `select id from tenant_memberships where tenant_id = $1 and user_id = $2`,
            [other.tenantId, other.ownerUserId],
          ),
        )
      ).rows[0]!.id;

      await expect(
        db.asUser(other.ownerUserId, () =>
          db.query(`select set_member_pin($1, '4417')`, [otherMembership]),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('issuing a PIN to staff', () => {
    it('requires permission to manage staff', async () => {
      const { userId: cashier } = await addMember(db, shop.tenantId, { roleKey: 'cashier' });
      const { membershipId: target } = await addMember(db, shop.tenantId, { roleKey: 'cashier' });
      await expect(
        db.asUser(cashier, () => db.query(`select set_member_pin($1, '7391')`, [target])),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('refuses obvious PINs', async () => {
      const { membershipId } = await addMember(db, shop.tenantId, { roleKey: 'cashier' });
      for (const weak of ['0000', '1111', '1234', '1024']) {
        await expect(
          db.asUser(shop.ownerUserId, () =>
            db.query(`select set_member_pin($1, $2)`, [membershipId, weak]),
          ),
          `accepted ${weak}`,
        ).rejects.toThrow(/VALIDATION_FAILED/);
      }
    });
  });

  describe('choosing your own PIN', () => {
    it('does not ask for the current one when it was issued to you', async () => {
      // They just typed it to get here; asking again is ceremony.
      await givePin(shop.ownerUserId, '4417', true);
      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(`select change_my_pin($1, null, '8265')`, [shop.tenantId]),
        ),
      ).resolves.toBeDefined();
      expect((await verify(await slug(), '8265')).must_change).toBe(false);
    });

    it('asks for the current one once the PIN is yours', async () => {
      // Otherwise anyone at an unattended till changes the cashier's credential.
      await givePin(shop.ownerUserId, '4417', false);
      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(`select change_my_pin($1, '0000', '8265')`, [shop.tenantId]),
        ),
      ).rejects.toThrow(/INVALID_PIN/);
    });

    it('cannot change a PIN in a business you do not belong to', async () => {
      const other = await createTenant(db);
      await expect(
        db.asUser(shop.ownerUserId, () =>
          db.query(`select change_my_pin($1, '4417', '8265')`, [other.tenantId]),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('never records either PIN in the audit log', async () => {
      await givePin(shop.ownerUserId, '4417', true);
      await db.asUser(shop.ownerUserId, () =>
        db.query(`select change_my_pin($1, null, '8265')`, [shop.tenantId]),
      );
      const { rows } = await db.asServiceRole(() =>
        db.query<{ blob: string }>(
          `select coalesce(metadata::text,'') as blob from audit_logs
            where action = 'STAFF_PIN_CHANGED'`,
        ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.blob).not.toContain('4417');
      expect(rows[0]!.blob).not.toContain('8265');
    });
  });

  describe('a PIN grants no more than the member already had', () => {
    it('does not let a cashier reach another business', async () => {
      const other = await createTenant(db);
      const { userId: cashier } = await addMember(db, shop.tenantId, { roleKey: 'cashier' });
      await givePin(cashier, '8265', false);

      const { rows } = await db.asUser(cashier, () =>
        db.query<{ count: string }>(`select count(*)::text as count from tenants where id = $1`, [
          other.tenantId,
        ]),
      );
      expect(rows[0]!.count).toBe('0');
    });
  });
});

/**
 * The starting PIN the platform owner reads out to a new customer.
 */
describe('the initial PIN', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });

  it('is issued to the business owner and works once', async () => {
    await db.reset();
    const { createUser } = await import('../support/fixtures.js');
    const platformOwner = await createUser(db, { isPlatformAdmin: true });
    const shop = await createTenant(db);

    const { rows } = await db.asUser(platformOwner, () =>
      db.query<{ out_pin: string; out_email: string }>(`select * from issue_initial_pin($1)`, [
        shop.tenantId,
      ]),
    );
    const pin = rows[0]!.out_pin;
    expect(pin).toMatch(/^[0-9]{4}$/);

    const slug = (
      await db.asServiceRole(() =>
        db.query<{ slug: string }>(`select slug from tenants where id = $1`, [shop.tenantId]),
      )
    ).rows[0]!.slug;

    const { rows: verified } = await db.asServiceRole(() =>
      db.query<{ out_status: string; out_user_id: string; out_must_change: boolean }>(
        `select * from verify_member_pin($1, $2)`,
        [slug, pin],
      ),
    );
    expect(verified[0]!.out_status).toBe('OK');
    expect(verified[0]!.out_user_id).toBe(shop.ownerUserId);
    // They are asked to choose their own the moment they use it.
    expect(verified[0]!.out_must_change).toBe(true);
  });

  it('cannot be issued by a merchant', async () => {
    await db.reset();
    const shop = await createTenant(db);
    await expect(
      db.asUser(shop.ownerUserId, () =>
        db.query(`select * from issue_initial_pin($1)`, [shop.tenantId]),
      ),
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('never appears in the audit log', async () => {
    await db.reset();
    const { createUser } = await import('../support/fixtures.js');
    const platformOwner = await createUser(db, { isPlatformAdmin: true });
    const shop = await createTenant(db);
    const { rows } = await db.asUser(platformOwner, () =>
      db.query<{ out_pin: string }>(`select * from issue_initial_pin($1)`, [shop.tenantId]),
    );
    const { rows: audit } = await db.asServiceRole(() =>
      db.query<{ blob: string }>(
        `select coalesce(metadata::text,'') as blob from audit_logs
          where action = 'STAFF_PIN_ISSUED' and tenant_id = $1`,
        [shop.tenantId],
      ),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.blob).not.toContain(rows[0]!.out_pin);
  });
});
