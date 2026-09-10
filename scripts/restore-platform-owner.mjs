/**
 * Restores the platform owner's `platform_admins` record after their Auth account exists.
 *
 * ## Why this is a script and not a SQL snippet in a runbook
 *
 * The owner's account was destroyed once already, by ad-hoc tooling pointed at the wrong
 * database. This refuses to act unless it can see the exact account it was told to restore,
 * it never creates one, and it is idempotent — running it twice does not produce a second
 * administrator.
 *
 * ## What it deliberately does NOT do
 *
 *   * It does not create an Auth account. Identity is not something to infer: a platform
 *     administrator can onboard, suspend and bill every customer on Carl, and guessing which
 *     address deserves that is not a mistake worth risking. Create the account in the
 *     Supabase dashboard first (Authentication -> Add user, email confirmed).
 *   * It does not set a PIN. Migration 0035's BEFORE INSERT trigger does that, which is the
 *     point: if this script set one, it would hide a regression in the trigger exactly the
 *     way the old test fixture did.
 *   * It does not touch tenants, sales, inventory or any other user.
 *
 * ## Usage
 *
 *     SUPABASE_DB_URL="..." OWNER_EMAIL="..." node scripts/restore-platform-owner.mjs [--commit]
 *
 * Without `--commit` it reports what it would do and changes nothing.
 *
 * Prints no email, no user id, no hash, no token, no connection string.
 */

import pg from 'pg';

const commit = process.argv.includes('--commit');
const email = process.env.OWNER_EMAIL;
const url = process.env.SUPABASE_DB_URL;

if (!url) {
  console.error('SUPABASE_DB_URL is required.');
  process.exit(2);
}
if (!email) {
  console.error('OWNER_EMAIL is required (the address the Auth account was created with).');
  process.exit(2);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const one = async (sql, params = []) => (await client.query(sql, params)).rows[0];

try {
  const user = await one('select id from auth.users where lower(email) = lower($1)', [email]);
  if (!user) {
    console.error('No Auth account exists for that address in this database.');
    console.error('Create it first: Supabase dashboard -> Authentication -> Add user, then');
    console.error('confirm the email. This script will not create an identity.');
    process.exit(1);
  }
  console.log('auth account            : found');

  // The profile is the application's own record of a person, and platform_admins references
  // it rather than auth.users. Created here only if missing, and only for this account.
  const profile = await one('select id from profiles where id = $1', [user.id]);
  if (!profile) {
    if (commit) {
      await client.query(
        `insert into profiles (id, email, full_name)
         select u.id, u.email, coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), 'Platform Owner')
           from auth.users u where u.id = $1`,
        [user.id],
      );
    }
    console.log(`profile                 : ${commit ? 'created' : 'MISSING (would create)'}`);
  } else {
    console.log('profile                 : present');
  }

  const already = await one('select user_id from platform_admins where user_id = $1', [user.id]);
  if (already) {
    console.log('platform_admins record  : already present (no duplicate created)');
  } else if (commit) {
    // No pin_hash supplied on purpose: the trigger owns initialisation.
    await client.query(
      `insert into platform_admins (user_id, note) values ($1, 'Platform owner (restored)')`,
      [user.id],
    );
    console.log('platform_admins record  : created');
  } else {
    console.log('platform_admins record  : MISSING (would create)');
  }

  if (!commit) {
    console.log('\nDry run. Nothing was changed. Re-run with --commit to apply.');
    process.exit(0);
  }

  // Verified by property, never by value.
  const state = await one(
    `select (pa.pin_hash is not null) as has_pin,
            pa.pin_is_default          as is_default,
            (pa.pin_set_at is not null) as pin_timestamped,
            (select count(*)::int from platform_admins) as admin_count,
            (select count(*)::int from tenant_memberships tm where tm.user_id = pa.user_id) as staff_memberships
       from platform_admins pa where pa.user_id = $1`,
    [user.id],
  );
  console.log('\n--- resulting administrator ---');
  console.log('  has a PIN hash        :', state.has_pin);
  console.log('  flagged as default    :', state.is_default);
  console.log('  PIN timestamped       :', state.pin_timestamped);
  console.log('  total administrators  :', state.admin_count);
  console.log('  staff/till memberships:', state.staff_memberships, '(0 = platform owner only)');

  const ok = await one(
    `select status, (user_id = $1) as is_this_owner, is_default
       from verify_platform_pin('1024')`,
    [user.id],
  );
  console.log('\n--- verify_platform_pin with the documented default ---');
  console.log('  status                :', ok?.status);
  console.log('  resolves to this owner:', ok?.is_this_owner);
  console.log('  is_default            :', ok?.is_default);

  // Leave the throttle clean: the probe above counts as an attempt.
  await client.query(
    'update platform_pin_throttle set consecutive_failures = 0, locked_until = null',
  );
} finally {
  await client.end().catch(() => undefined);
}
