import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { createUser } from '../support/fixtures.js';

/**
 * The half of signing in that happens after the PIN is accepted.
 *
 * Verifying a PIN and starting a session are separate steps that fail for unrelated reasons,
 * and the difference was invisible from outside: the console showed one message for a wrong
 * PIN, a dead network and a broken Auth service alike.
 *
 * The outage this covers: the platform owner's `auth.users` row had been created by hand with
 * only `(id, email)`. GoTrue is Go — it scans several columns into non-nullable strings, and
 * it treats a row with no `email_confirmed_at` as an account that has not signed up. So a
 * magic-link request tried to INSERT and collided with `users_email_partial_key`, the Auth
 * admin API answered 500, and the owner — who had entered the correct PIN — was told
 * "We're having trouble connecting right now."
 *
 * These tests assert the shape of the account, because that is what the session depends on
 * and what nothing else checks. They do not mint a session: that needs GoTrue, which is not
 * part of this suite.
 */
describe('the platform owner account can actually hold a session', () => {
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
    // The documented production path: create the account, then grant it.
    owner = await createUser(db, { isPlatformAdmin: true });
    await db.asServiceRole(() =>
      db.query(`update platform_pin_throttle set consecutive_failures = 0, locked_until = null`),
    );
  });

  it('has an Auth row GoTrue can read', async () => {
    const { rows } = await db.asAdmin(() =>
      db.query<{
        confirmed: boolean;
        identified: boolean;
        tokens_present: boolean;
        metadata_present: boolean;
      }>(
        `select (email_confirmed_at is not null) as confirmed,
                (aud is not null and role is not null) as identified,
                (confirmation_token is not null and recovery_token is not null
                 and email_change_token_new is not null and email_change is not null
                 and email_change_token_current is not null and phone_change_token is not null
                 and reauthentication_token is not null) as tokens_present,
                (raw_app_meta_data is not null and raw_user_meta_data is not null) as metadata_present
           from auth.users where id = $1`,
        [owner],
      ),
    );
    const row = rows[0]!;
    // Unconfirmed is the specific state that made GoTrue attempt a signup.
    expect(row.confirmed, 'an unconfirmed account makes magic-link sign-in attempt a signup').toBe(
      true,
    );
    expect(row.identified, 'aud/role missing: GoTrue cannot issue a token for this row').toBe(true);
    expect(row.tokens_present, 'a NULL token column is a row GoTrue cannot scan').toBe(true);
    expect(row.metadata_present).toBe(true);
  });

  it('has exactly one Auth row for its address, so a signup attempt cannot collide', async () => {
    // `users_email_partial_key` is what actually raised 23505 in production.
    const { rows } = await db.asAdmin(() =>
      db.query<{ n: number }>(
        `select count(*)::int as n from auth.users
          where lower(email) = (select lower(email) from auth.users where id = $1)`,
        [owner],
      ),
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('verifies the documented default PIN and identifies that same account', async () => {
    const { rows } = await db.asServiceRole(() =>
      db.query<{ status: string; user_id: string | null; is_default: boolean | null }>(
        `select status, user_id, is_default from verify_platform_pin('1024')`,
      ),
    );
    expect(rows[0]!.status).toBe('OK');
    expect(rows[0]!.user_id, 'a session would be minted for the wrong account').toBe(owner);
    expect(rows[0]!.is_default).toBe(true);
  });

  it('is a platform owner and not a till user', async () => {
    // The two authentication paths are separate boundaries. An owner must not need a device,
    // a till registration or a cashier assignment.
    const { rows } = await db.asServiceRole(() =>
      db.query<{ memberships: number }>(
        `select count(*)::int as memberships from tenant_memberships where user_id = $1`,
        [owner],
      ),
    );
    expect(rows[0]!.memberships, 'the platform owner has a staff membership').toBe(0);
  });

  it('keeps a wrong PIN distinguishable from a broken session', async () => {
    /*
     * The contract the console depends on. `verify_platform_pin` answers about the CREDENTIAL
     * only — it returns INVALID for a wrong PIN and never raises — so anything else going
     * wrong cannot be mistaken for a bad PIN, and is reported separately as
     * SESSION_CREATION_FAILED rather than as a connection problem.
     */
    const { rows } = await db.asServiceRole(() =>
      db.query<{ status: string; user_id: string | null }>(
        `select status, user_id from verify_platform_pin('7391')`,
      ),
    );
    expect(rows[0]!.status).toBe('INVALID');
    expect(rows[0]!.user_id).toBeNull();
  });
});
