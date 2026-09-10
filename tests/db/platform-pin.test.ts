import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { createUser, createTenant } from '../support/fixtures.js';

/**
 * The owner PIN.
 *
 * Four digits guard the account that can onboard, suspend and bill every customer on Carl,
 * so the throttle is not a nicety — it is the only thing standing between an attacker and
 * a 10,000-item keyspace. These tests exist to prove it actually engages, that the PIN is
 * never readable, and that the verification function is not reachable by anyone who could
 * turn it into a public guessing oracle.
 */
describe('platform owner PIN', () => {
  let db: TestDatabase;
  let owner: string;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.reset();
    owner = await createUser(db, { isPlatformAdmin: true });
    // The seeding UPDATE in the migration ran before this fixture existed, so give this
    // administrator the documented default explicitly.
    await db.asServiceRole(() =>
      db.query(
        `update platform_admins
            set pin_hash = extensions.crypt('1024', extensions.gen_salt('bf', 4)),
                pin_set_at = now(), pin_is_default = true
          where user_id = $1`,
        [owner],
      ),
    );
    // Deliberately NOT re-inserting the throttle row: the harness truncates it, and the
    // function is required to recreate it. See 'survives the throttle row going missing'.
    await db.asServiceRole(() =>
      db.query(`update platform_pin_throttle set consecutive_failures = 0, locked_until = null`),
    );
  });

  /**
   * The function returns a status rather than raising, because raising would roll back the
   * failed-attempt counter it just wrote. The tests assert on that status.
   */
  async function verify(pin: string) {
    const { rows } = await db.asServiceRole(() =>
      db.query<{
        status: string;
        user_id: string | null;
        email: string | null;
        is_default: boolean | null;
      }>(`select * from verify_platform_pin($1)`, [pin]),
    );
    return rows[0]!;
  }

  describe('signing in', () => {
    it('accepts the correct PIN and identifies the owner', async () => {
      const result = await verify('1024');
      expect(result.status).toBe('OK');
      expect(result.user_id).toBe(owner);
      expect(result.is_default).toBe(true);
    });

    it('rejects a wrong PIN', async () => {
      const result = await verify('9999');
      expect(result.status).toBe('INVALID');
      expect(result.user_id, 'a rejected attempt still named an account').toBeNull();
    });

    it('rejects anything that is not four digits', async () => {
      for (const bad of ['123', '12345', 'abcd', '', '10 4']) {
        expect((await verify(bad)).status, `accepted ${JSON.stringify(bad)}`).toBe('INVALID');
      }
    });

    it('records when the owner last signed in', async () => {
      await verify('1024');
      const { rows } = await db.asServiceRole(() =>
        db.query<{ last_login_at: string | null }>(
          `select last_login_at from platform_admins where user_id = $1`,
          [owner],
        ),
      );
      expect(rows[0]?.last_login_at).toBeTruthy();
    });
  });

  describe('the throttle', () => {
    it('locks after repeated wrong guesses', async () => {
      // The property the whole design rests on: guessing must stop being cheap.
      for (let i = 0; i < 3; i += 1) {
        expect((await verify('0000')).status).toBe('INVALID');
      }
      expect((await verify('0001')).status).toBe('LOCKED');
    });

    it('refuses the CORRECT pin while locked', async () => {
      // Otherwise the lock is decorative: an attacker who guesses correctly on the attempt
      // that trips the lock would still be let in.
      for (let i = 0; i < 4; i += 1) await verify('0000');
      expect((await verify('1024')).status, 'the lock let a correct PIN through').toBe('LOCKED');
    });

    it('clears the count on a correct PIN', async () => {
      expect((await verify('0000')).status).toBe('INVALID');
      expect((await verify('1024')).status).toBe('OK');
      const { rows } = await db.asServiceRole(() =>
        db.query<{ consecutive_failures: number }>(
          `select consecutive_failures from platform_pin_throttle`,
        ),
      );
      expect(rows[0]?.consecutive_failures).toBe(0);
    });

    it('survives the throttle row going missing', async () => {
      /*
       * A regression test for a real defect.
       *
       * The function used to SELECT the throttle row and then UPDATE it. With no row — a
       * restore, a stray DELETE, a TRUNCATE — the update matched nothing, the counter never
       * moved, and brute-force protection was silently gone while every call still looked
       * like it worked. Nothing reported the loss.
       */
      await db.asServiceRole(() => db.query(`delete from platform_pin_throttle`));

      for (let i = 0; i < 3; i += 1) {
        expect((await verify('0000')).status).toBe('INVALID');
      }
      expect(
        (await verify('0001')).status,
        'the throttle did not engage after its row was deleted',
      ).toBe('LOCKED');
    });

    it('lets the owner back in once the lock expires', async () => {
      for (let i = 0; i < 4; i += 1) await verify('0000');
      await db.asServiceRole(() =>
        db.query(`update platform_pin_throttle set locked_until = now() - interval '1 second'`),
      );
      const result = await verify('1024');
      expect(result.status).toBe('OK');
      expect(result.user_id).toBe(owner);
    });
  });

  describe('who may attempt a PIN', () => {
    it('is not callable by an anonymous visitor', async () => {
      // The difference between a throttled server-side check and a public brute-force
      // oracle is exactly this grant.
      await expect(
        db.asAnon(() => db.query(`select * from verify_platform_pin('1024')`)),
      ).rejects.toThrow(/permission denied|does not exist/i);
    });

    it('is not callable by a signed-in merchant', async () => {
      const shop = await createTenant(db);
      await expect(
        db.asUser(shop.ownerUserId, () => db.query(`select * from verify_platform_pin('1024')`)),
      ).rejects.toThrow(/permission denied|does not exist/i);
    });
  });

  describe('the PIN is never readable', () => {
    it('is stored only as a hash', async () => {
      const { rows } = await db.asServiceRole(() =>
        db.query<{ pin_hash: string }>(`select pin_hash from platform_admins where user_id = $1`, [
          owner,
        ]),
      );
      expect(rows[0]!.pin_hash).not.toContain('1024');
      expect(rows[0]!.pin_hash).toMatch(/^\$2[aby]?\$/); // bcrypt
    });

    it('does not appear anywhere in the audit log after a change', async () => {
      await db.asUser(owner, () => db.query(`select change_platform_pin('1024', '7391')`));
      const { rows } = await db.asServiceRole(() =>
        db.query<{ blob: string }>(
          `select coalesce(metadata::text,'') || coalesce(before_state::text,'')
                  || coalesce(after_state::text,'') as blob
             from audit_logs where action = 'PLATFORM_PIN_CHANGED'`,
        ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.blob).not.toContain('1024');
      expect(rows[0]!.blob).not.toContain('7391');
    });
  });

  describe('changing the PIN', () => {
    it('requires the current PIN', async () => {
      // Without this, anyone at an unlocked signed-in console locks the owner out of their
      // own platform.
      await expect(
        db.asUser(owner, () => db.query(`select change_platform_pin('0000', '7391')`)),
      ).rejects.toThrow(/INVALID_PIN/);
    });

    it('changes it, and the old PIN stops working', async () => {
      await db.asUser(owner, () => db.query(`select change_platform_pin('1024', '7391')`));
      await db.asServiceRole(() =>
        db.query(`update platform_pin_throttle set consecutive_failures = 0, locked_until = null`),
      );
      const result = await verify('7391');
      expect(result.status).toBe('OK');
      expect(result.user_id).toBe(owner);
      expect(result.is_default, 'still flagged as the default after a change').toBe(false);

      await db.asServiceRole(() =>
        db.query(`update platform_pin_throttle set consecutive_failures = 0, locked_until = null`),
      );
      expect((await verify('1024')).status, 'the old PIN still works').toBe('INVALID');
    });

    it('refuses the published default', async () => {
      await expect(
        db.asUser(owner, () => db.query(`select change_platform_pin('1024', '1024')`)),
      ).rejects.toThrow(/VALIDATION_FAILED/);
    });

    it('refuses obvious PINs', async () => {
      for (const weak of ['0000', '1111', '1234', '4321']) {
        await expect(
          db.asUser(owner, () => db.query(`select change_platform_pin('1024', $1)`, [weak])),
          `accepted ${weak}`,
        ).rejects.toThrow(/VALIDATION_FAILED/);
      }
    });

    it('cannot be changed by a merchant', async () => {
      const shop = await createTenant(db);
      await expect(
        db.asUser(shop.ownerUserId, () => db.query(`select change_platform_pin('1024', '7391')`)),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('cannot be changed by an anonymous caller', async () => {
      await expect(
        db.asAnon(() => db.query(`select change_platform_pin('1024', '7391')`)),
      ).rejects.toThrow(/permission denied|PERMISSION_DENIED/i);
    });
  });

  describe('a correct PIN grants no more than the account already had', () => {
    it('does not let the owner read a merchant’s sales', async () => {
      // The PIN is a way in, not a privilege escalation. RLS still decides everything.
      await createTenant(db);
      const { rows } = await db.asUser(owner, () =>
        db.query<{ count: string }>(`select count(*)::text as count from sales`),
      );
      expect(rows[0]!.count).toBe('0');
    });
  });
});
