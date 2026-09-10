/**
 * Walks the platform owner sign-in path end to end, the way the server action does.
 *
 * Each step is reported separately, because the console collapses every unexpected failure
 * into one message and the difference between "the PIN was wrong" and "the session could not
 * be minted" is invisible from the outside. That ambiguity is what made the last outage take
 * a full trace to diagnose.
 *
 *     SUPABASE_DB_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/verify-owner-login.mjs
 *
 * Prints no address, no key, no token, no hash. Read-only apart from resetting the PIN
 * throttle it necessarily increments.
 */

import pg from 'pg';

const url = process.env.SUPABASE_DB_URL;
const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;
const pin = process.env.OWNER_PIN ?? '1024';
if (!url || !srk) {
  console.error('SUPABASE_DB_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(2);
}
const ref = /:\/\/postgres\.([a-z0-9]+):/.exec(url)?.[1];
if (!ref) {
  console.error('Could not read the project ref from SUPABASE_DB_URL.');
  process.exit(2);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
let failed = false;

try {
  const admin = (
    await client.query(
      `select u.email, (u.email_confirmed_at is not null) as confirmed
         from auth.users u join platform_admins pa on pa.user_id = u.id limit 1`,
    )
  ).rows[0];
  console.log('1. administrator account      :', admin ? 'found' : 'MISSING');
  if (!admin) process.exit(1);
  console.log('   email confirmed           :', admin.confirmed);

  const v = (
    await client.query(
      `select status, (user_id is not null) as identified, is_default from verify_platform_pin($1)`,
      [pin],
    )
  ).rows[0];
  console.log('2. verify_platform_pin        :', v?.status);
  console.log('   owner identified          :', v?.identified);
  console.log('   is_default                :', v?.is_default);
  if (v?.status !== 'OK') failed = true;

  // The step that was failing: the session is minted through the Auth admin API.
  const res = await fetch(`https://${ref}.supabase.co/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: srk, Authorization: `Bearer ${srk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email: admin.email }),
  });
  console.log('3. admin generate_link        : HTTP', res.status);
  if (res.ok) {
    const body = await res.json();
    /*
     * The REST endpoint returns `hashed_token` at the top level; the supabase-js admin client
     * nests the same value under `properties`. The server action uses the client, so it reads
     * `properties.hashed_token` correctly — this script talks to REST directly and must accept
     * either, or it reports a working path as broken. It did exactly that once.
     */
    const hashed = body?.properties?.hashed_token ?? body?.hashed_token;
    console.log('   one-time token issued     :', Boolean(hashed));
    if (!hashed) {
      failed = true;
    } else {
      // The other half of the mint: exchanging the one-time token for a real session.
      const otp = await fetch(`https://${ref}.supabase.co/auth/v1/verify`, {
        method: 'POST',
        headers: { apikey: srk, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'magiclink', token_hash: hashed }),
      });
      console.log('4. session exchange           : HTTP', otp.status);
      if (otp.ok) {
        const session = await otp.json();
        console.log('   access token issued       :', Boolean(session?.access_token));
        console.log('   refresh token issued      :', Boolean(session?.refresh_token));
        if (!session?.access_token) failed = true;
      } else {
        const b = await otp.json().catch(() => ({}));
        console.log(
          '   response                  :',
          JSON.stringify(
            Object.fromEntries(
              Object.entries(b).filter(([k]) =>
                ['code', 'error_code', 'msg', 'message', 'error'].includes(k),
              ),
            ),
          ),
        );
        failed = true;
      }
    }
  } else {
    const body = await res.json().catch(() => ({}));
    const safe = Object.fromEntries(
      Object.entries(body).filter(([k]) =>
        ['code', 'error_code', 'msg', 'message', 'error'].includes(k),
      ),
    );
    console.log('   response                  :', JSON.stringify(safe));
    failed = true;
  }

  // The probe above counts as an attempt against a deliberately harsh throttle.
  await client.query(
    'update platform_pin_throttle set consecutive_failures = 0, locked_until = null',
  );
  console.log('\n' + (failed ? 'OWNER SIGN-IN PATH: FAILING' : 'OWNER SIGN-IN PATH: WORKING'));
} finally {
  await client.end().catch(() => undefined);
}
process.exit(failed ? 1 : 0);
