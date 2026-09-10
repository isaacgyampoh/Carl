/**
 * Makes a platform administrator's Auth account well-formed enough for GoTrue to use.
 *
 * ## The failure this repairs
 *
 * `auth.users` rows created by hand — an `insert into auth.users (id, email)` — are valid
 * PostgreSQL and invalid GoTrue. GoTrue is Go: it scans several columns into non-nullable
 * strings, and it treats a row with no `email_confirmed_at` as an account that has not
 * signed up yet.
 *
 * So `admin/generate_link` with `type: magiclink` tries to CREATE the account, and collides
 * with `users_email_partial_key`:
 *
 *     HTTP 500  code 23505  duplicate key value violates unique constraint
 *
 * The platform sign-in server action mints its session through exactly that call, so the
 * owner's correct PIN verified, the session could not be created, and the console reported
 * "We're having trouble connecting right now."
 *
 * ## Scope
 *
 * Authentication state only, and only for accounts that are already platform administrators.
 * It sets no password, changes no email, creates no account, grants no privilege, and does
 * not touch profiles, tenants, sales or any other user. Every column it writes is one GoTrue
 * itself would have written at signup.
 *
 * ## Usage
 *
 *     SUPABASE_DB_URL="..." node scripts/repair-auth-account.mjs [--commit]
 *
 * Without `--commit` it reports what it would change and changes nothing.
 */

import pg from 'pg';

const commit = process.argv.includes('--commit');
const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error('SUPABASE_DB_URL is required.');
  process.exit(2);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  // Only administrators, and only rows that are actually malformed.
  const { rows } = await client.query(`
    select u.id,
           (u.email_confirmed_at is null) as unconfirmed,
           (u.aud is null or u.role is null or u.instance_id is null) as identity_missing,
           (u.raw_app_meta_data is null or u.raw_user_meta_data is null) as metadata_missing,
           (u.confirmation_token is null or u.recovery_token is null
            or u.email_change_token_new is null or u.email_change is null
            or u.email_change_token_current is null or u.phone_change_token is null
            or u.reauthentication_token is null) as tokens_null
      from auth.users u
      join platform_admins pa on pa.user_id = u.id`);

  const broken = rows.filter(
    (r) => r.unconfirmed || r.identity_missing || r.metadata_missing || r.tokens_null,
  );
  console.log('administrator auth accounts :', rows.length);
  console.log('needing repair              :', broken.length);
  for (const r of broken) {
    console.log(
      `  unconfirmed=${r.unconfirmed} identity_missing=${r.identity_missing} ` +
        `metadata_missing=${r.metadata_missing} tokens_null=${r.tokens_null}`,
    );
  }
  if (broken.length === 0) {
    console.log('\nNothing to repair.');
    process.exit(0);
  }
  if (!commit) {
    console.log('\nDry run. Nothing was changed. Re-run with --commit to apply.');
    process.exit(0);
  }

  for (const r of broken) {
    await client.query(
      `update auth.users set
         instance_id        = coalesce(instance_id, '00000000-0000-0000-0000-000000000000'::uuid),
         aud                = coalesce(nullif(aud, ''), 'authenticated'),
         role               = coalesce(nullif(role, ''), 'authenticated'),
         email_confirmed_at = coalesce(email_confirmed_at, now()),
         created_at         = coalesce(created_at, now()),
         updated_at         = now(),
         raw_app_meta_data  = coalesce(raw_app_meta_data, '{"provider":"email","providers":["email"]}'::jsonb),
         raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb),
         -- GoTrue scans these into non-nullable strings. Empty is its own default; NULL is a
         -- row it cannot read at all.
         confirmation_token         = coalesce(confirmation_token, ''),
         recovery_token             = coalesce(recovery_token, ''),
         email_change_token_new     = coalesce(email_change_token_new, ''),
         email_change_token_current = coalesce(email_change_token_current, ''),
         email_change               = coalesce(email_change, ''),
         phone_change               = coalesce(phone_change, ''),
         phone_change_token         = coalesce(phone_change_token, ''),
         reauthentication_token     = coalesce(reauthentication_token, '')
       where id = $1`,
      [r.id],
    );
  }
  console.log(`\nrepaired ${broken.length} account(s).`);

  const after = await client.query(`
    select count(*)::int as still_broken
      from auth.users u join platform_admins pa on pa.user_id = u.id
     where u.email_confirmed_at is null or u.aud is null or u.role is null
        or u.raw_app_meta_data is null or u.confirmation_token is null`);
  console.log('still malformed             :', after.rows[0].still_broken);
} finally {
  await client.end().catch(() => undefined);
}
