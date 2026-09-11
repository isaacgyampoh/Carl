/**
 * Moves platform ownership onto a real Auth account, without an interruption in access.
 *
 * ## Why this exists
 *
 * The owner's original account was destroyed, and the administrator left behind was a test
 * fixture with an `@example.test` address. It works, and it must not stay: a production
 * platform owner carrying a fixture identity is a fixture identity with the power to onboard,
 * suspend and bill every customer on Carl.
 *
 * ## The order matters
 *
 * The new administrator is created and verified BEFORE the old one is touched. At no point is
 * there zero usable administrator — a failure halfway through leaves the owner able to sign
 * in, which is the whole reason the steps are in this order rather than a swap.
 *
 * The account is created through the Auth admin API rather than by inserting into
 * `auth.users`. A hand-made row is what caused the last outage: GoTrue scans several columns
 * into non-nullable strings and treats a row with no `email_confirmed_at` as one that has not
 * signed up, so generating a magic link tried to INSERT and collided with the unique index on
 * email. Letting GoTrue create its own row makes that class of defect impossible here.
 *
 * No PIN is set. Migration 0035's trigger does it, and the resulting administrator starts on
 * the documented default with `pin_is_default` true, so first sign-in still demands a change.
 *
 * ## Usage
 *
 *     SUPABASE_DB_URL=... SUPABASE_SERVICE_ROLE_KEY=... OWNER_EMAIL=... \
 *       node scripts/provision-platform-owner.mjs [--commit] [--retire-fixtures]
 *
 * Prints no address, key, token or hash.
 */

import pg from 'pg';

const commit = process.argv.includes('--commit');
const retire = process.argv.includes('--retire-fixtures');
const url = process.env.SUPABASE_DB_URL;
const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.OWNER_EMAIL;
if (!url || !srk || !email) {
  console.error('SUPABASE_DB_URL, SUPABASE_SERVICE_ROLE_KEY and OWNER_EMAIL are required.');
  process.exit(2);
}
const ref = /:\/\/postgres\.([a-z0-9]+):/.exec(url)?.[1];
if (!ref) {
  console.error('Could not read the project ref from SUPABASE_DB_URL.');
  process.exit(2);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
const one = async (sql, params = []) => (await client.query(sql, params)).rows[0];
const auth = (path, init) =>
  fetch(`https://${ref}.supabase.co/auth/v1/admin/${path}`, {
    ...init,
    headers: { apikey: srk, Authorization: `Bearer ${srk}`, 'Content-Type': 'application/json' },
  });

try {
  // 1. What is currently holding platform ownership.
  const before = await one(
    `select count(*)::int as admins,
            count(*) filter (where u.email like '%@example.test')::int as fixture_admins
       from platform_admins pa join auth.users u on u.id = pa.user_id`,
  );
  console.log(
    '1. current administrators     :',
    before.admins,
    `(fixture: ${before.fixture_admins})`,
  );

  // 2. The real account. Created by GoTrue, or reused if it already exists.
  let existing = await one('select id from auth.users where lower(email) = lower($1)', [email]);
  if (existing) {
    console.log('2. real Auth account          : already exists');
  } else if (!commit) {
    console.log('2. real Auth account          : MISSING (would create via the Auth admin API)');
  } else {
    const res = await auth('users', {
      method: 'POST',
      body: JSON.stringify({ email, email_confirm: true }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      console.error('   could not create the account: HTTP', res.status, b.msg ?? b.message ?? '');
      process.exit(1);
    }
    console.log('2. real Auth account          : created (email confirmed)');
    existing = await one('select id from auth.users where lower(email) = lower($1)', [email]);
  }
  if (!commit) {
    console.log('\nDry run. Nothing was changed. Re-run with --commit to apply.');
    process.exit(0);
  }

  const ownerId = existing.id;

  // 3. The application's own record of the person.
  await client.query(
    `insert into profiles (id, email, full_name)
     select u.id, u.email, 'Platform Owner' from auth.users u where u.id = $1
     on conflict (id) do nothing`,
    [ownerId],
  );
  console.log('3. profile                    : present');

  // 4. Ownership. No pin_hash supplied: the trigger owns initialisation.
  await client.query(
    `insert into platform_admins (user_id, note) values ($1, 'Platform owner')
     on conflict (user_id) do nothing`,
    [ownerId],
  );
  const state = await one(
    `select (pin_hash is not null) as has_pin, pin_is_default as is_default,
            (select count(*)::int from tenant_memberships tm where tm.user_id = $1) as staff
       from platform_admins where user_id = $1`,
    [ownerId],
  );
  console.log('4. platform ownership         : granted');
  console.log('   has a PIN hash             :', state.has_pin);
  console.log('   default-PIN state          :', state.is_default);
  console.log('   staff memberships          :', state.staff, '(0 = owner only, not a till user)');

  // 5. The default PIN must match THIS account specifically, independently of any other
  //    administrator that still exists.
  const matches = await one(
    `select (pin_hash = extensions.crypt('1024', pin_hash)) as matches
       from platform_admins where user_id = $1`,
    [ownerId],
  );
  console.log('5. default PIN resolves here  :', matches.matches);

  if (!retire) {
    console.log('\nNew owner is in place. Re-run with --retire-fixtures to remove the old one.');
    process.exit(matches.matches ? 0 : 1);
  }

  // 6. Only now, and only fixture accounts, and only once the real owner is proven.
  if (!matches.matches) {
    console.error('Refusing to retire anything: the new owner does not verify.');
    process.exit(1);
  }
  const removed = await client.query(
    `delete from platform_admins pa
      using auth.users u
      where u.id = pa.user_id and u.email like '%@example.test'
      returning pa.user_id`,
  );
  console.log('6. fixture administrators removed:', removed.rowCount);

  const after = await one(
    `select count(*)::int as admins,
            count(*) filter (where u.email like '%@example.test')::int as fixture_admins
       from platform_admins pa join auth.users u on u.id = pa.user_id`,
  );
  console.log(
    '   administrators now         :',
    after.admins,
    `(fixture: ${after.fixture_admins})`,
  );

  const resolves = await one(
    `select status, (user_id = $1) as is_real_owner, is_default from verify_platform_pin('1024')`,
    [ownerId],
  );
  console.log('7. verify_platform_pin        :', resolves.status);
  console.log('   resolves to the real owner :', resolves.is_real_owner);
  console.log('   is_default                 :', resolves.is_default);
  await client.query(
    'update platform_pin_throttle set consecutive_failures = 0, locked_until = null',
  );
  process.exit(resolves.status === 'OK' && resolves.is_real_owner ? 0 : 1);
} finally {
  await client.end().catch(() => undefined);
}
