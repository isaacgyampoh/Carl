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
    /*
     * Created exactly the way production creates one: an insert into `platform_admins` and
     * nothing else. The PIN now arrives from the BEFORE INSERT trigger in migration 0035.
     *
     * This fixture used to hand-set the hash here, with a comment noting that the migration's
     * seeding UPDATE had already run. That workaround is why the defect survived: the suite
     * granted every test administrator a PIN that a real one never received, so
     * `verify_platform_pin` always had a candidate row and the tests passed against a
     * production path that could not work.
     */
    owner = await createUser(db, { isPlatformAdmin: true });
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

  describe('an administrator created the way production creates one', () => {
    /*
     * The regression test for a live production defect: the owner could not sign in with
     * the documented default PIN, and was told "That PIN is not correct".
     *
     * Migration 0031 seeded the default with a one-time
     * `update ... where pin_hash is null`, which only ever touched rows that existed when
     * that migration ran. docs/DEPLOYMENT.md tells an operator to insert the administrator
     * AFTER deploying the schema, so the real row got `pin_hash = NULL` — and
     * `verify_platform_pin` skips administrators without a hash. No candidate rows, no
     * successful PIN, for any input.
     *
     * These tests deliberately do NOT set a PIN themselves. Setting one is precisely the
     * workaround that let this ship. Remove the trigger from 0035 and every assertion in
     * this block fails.
     */
    let fresh: string;

    beforeEach(async () => {
      // The documented deployment step, and nothing more.
      fresh = await createUser(db, { isPlatformAdmin: true });
      await db.asServiceRole(() =>
        db.query(`update platform_pin_throttle set consecutive_failures = 0, locked_until = null`),
      );
    });

    it('is given a PIN at all', async () => {
      const { rows } = await db.asServiceRole(() =>
        db.query<{ has_hash: boolean; is_default: boolean }>(
          `select pin_hash is not null as has_hash, pin_is_default as is_default
             from platform_admins where user_id = $1`,
          [fresh],
        ),
      );
      // Asserted on presence, never on the value: the hash is a credential.
      expect(rows[0]!.has_hash, 'the administrator has no PIN and can never sign in').toBe(true);
      expect(rows[0]!.is_default, 'the console will not insist the default be changed').toBe(true);
    });

    it('signs in with the documented default PIN', async () => {
      const result = await verify('1024');
      expect(result.status, 'the default PIN was rejected for a real administrator').toBe('OK');
      expect(result.user_id).not.toBeNull();
      expect(result.email).not.toBeNull();
      // Drives the redirect to the change-PIN screen.
      expect(result.is_default).toBe(true);
    });

    it('refuses an incorrect PIN', async () => {
      expect((await verify('7391')).status).toBe('INVALID');
    });

    it('refuses a PIN of the wrong length', async () => {
      for (const bad of ['1', '102', '10245', '12345678']) {
        expect((await verify(bad)).status, `accepted ${bad}`).toBe('INVALID');
      }
    });

    it('refuses an empty PIN and a non-numeric one', async () => {
      for (const bad of ['', '    ', 'abcd', '10a4']) {
        expect((await verify(bad)).status, `accepted ${JSON.stringify(bad)}`).toBe('INVALID');
      }
    });

    it('never returns the stored hash to the caller', async () => {
      // The function's result shape is part of the security boundary.
      const result = await verify('1024');
      expect(Object.keys(result).sort()).toEqual(['email', 'is_default', 'status', 'user_id']);
    });

    it('still signs in after the PIN has been changed away from the default', async () => {
      await db.asUser(fresh, () => db.query(`select change_platform_pin('1024', '7391')`));

      const changed = await verify('7391');
      expect(changed.status).toBe('OK');
      expect(changed.user_id).toBe(fresh);
      expect(changed.is_default, 'still flagged as the default').toBe(false);

      /*
       * Asserted on identity, not on status.
       *
       * `verify_platform_pin` checks every administrator holding a PIN, deliberately — so
       * that a second owner is not locked out of their own console. This suite's outer
       * fixture creates one, and it legitimately still holds the default. The claim worth
       * making is narrower and is the one that matters: the administrator who changed their
       * PIN can no longer be reached with the old one.
       */
      const withOldPin = await verify('1024');
      expect(withOldPin.user_id, 'the replaced default still signs this owner in').not.toBe(fresh);
    });

    it('does not overwrite a PIN that was supplied at insert time', async () => {
      /*
       * The trigger fills a gap; it must never replace a real credential with a published
       * default. An administrator inserted with a chosen hash keeps it.
       */
      const chosen = await createUser(db);
      await db.asServiceRole(() =>
        db.query(
          `insert into platform_admins (user_id, pin_hash, pin_is_default)
           values ($1, extensions.crypt('7391', extensions.gen_salt('bf', 4)), false)`,
          [chosen],
        ),
      );
      await db.asServiceRole(() =>
        db.query(`update platform_pin_throttle set consecutive_failures = 0, locked_until = null`),
      );

      expect((await verify('7391')).status).toBe('OK');
      const { rows } = await db.asServiceRole(() =>
        db.query<{ is_default: boolean }>(
          `select pin_is_default as is_default from platform_admins where user_id = $1`,
          [chosen],
        ),
      );
      expect(rows[0]!.is_default, 'a chosen PIN was marked as the default').toBe(false);
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
