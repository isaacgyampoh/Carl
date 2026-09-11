/**
 * Prepares a staging project for the end-to-end suite.
 *
 * The suite creates and removes its own business on every run; what it cannot create is the
 * platform owner who onboards that business. This makes one, the way production made one: an
 * account through the Auth admin API, never a hand-written auth.users row, and a platform_admins
 * entry whose PIN the database's own trigger sets.
 *
 * Idempotent — run it as often as you like. It prints no key, token, password or PIN.
 *
 *   SB_URL=… SB_SERVICE=… SUPABASE_DB_URL=… node scripts/seed-staging.mjs
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const {
  SB_URL,
  SB_SERVICE,
  SUPABASE_DB_URL,
  OWNER_EMAIL = 'owner@staging.carl.invalid',
} = process.env;
for (const [name, value] of Object.entries({ SB_URL, SB_SERVICE, SUPABASE_DB_URL })) {
  if (!value) throw new Error(`${name} is required`);
}
if (/carl-red\.vercel\.app|thecarl\.cc/.test(SB_URL)) {
  throw new Error(
    'refusing: this seeds a platform owner, and that is not something to do to production',
  );
}

const admin = async (path, method = 'GET', body) => {
  const res = await fetch(`${SB_URL}/auth/v1/admin${path}`, {
    method,
    headers: {
      apikey: SB_SERVICE,
      authorization: `Bearer ${SB_SERVICE}`,
      'content-type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

// One account, found or created.
const listed = await admin(`/users?per_page=200`);
const found = (listed.json.users ?? []).find((user) => user.email === OWNER_EMAIL);
const account =
  found ??
  (
    await admin('/users', 'POST', {
      email: OWNER_EMAIL,
      email_confirm: true,
      password: randomUUID() + randomUUID(),
      user_metadata: { full_name: 'Staging platform owner' },
    })
  ).json;
if (!account?.id) throw new Error('the owner account could not be created');
console.log(found ? 'owner account already existed' : 'owner account created');

const db = new Client({ connectionString: SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
try {
  // A profile, because every signed-in caller is resolved through one.
  await db.query(
    `insert into public.profiles (id, email, full_name)
     values ($1, $2, 'Staging platform owner')
     on conflict (id) do update set email = excluded.email`,
    [account.id, OWNER_EMAIL],
  );
  // Platform administration. The trigger from migration 0035 sets the starting PIN.
  await db.query(
    `insert into public.platform_admins (user_id, note)
     values ($1, 'staging end-to-end suite')
     on conflict (user_id) do nothing`,
    [account.id],
  );
  const { rows } = await db.query(
    `select (select count(*)::int from public.platform_admins) admins,
            (select count(*)::int from public.subscription_plans where is_active) plans,
            (select count(*)::int from public.tenants) businesses`,
  );
  console.log(
    `staging ready: ${rows[0].admins} platform owner(s), ${rows[0].plans} active plan(s), ${rows[0].businesses} business(es)`,
  );
} finally {
  await db.end();
}
