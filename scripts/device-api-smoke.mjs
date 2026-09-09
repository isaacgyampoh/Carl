/**
 * End-to-end check of the three terminal endpoints, over real HTTP.
 *
 * This exists because the class of bug it catches is invisible to everything else. The
 * routes typecheck, the routes build, and their logic is unit tested — and until this ran,
 * every one of them answered `307 → /sign-in`, because a till has no browser session and
 * the middleware only understands cookies. No amount of testing the route handler finds
 * that: the handler is never reached.
 *
 * So this drives a real server the way a terminal does, and asserts on what comes back.
 *
 *   SUPABASE_DB_URL=... CARL_SMOKE_BASE=http://localhost:3100 node scripts/device-api-smoke.mjs
 */
import { randomUUID } from 'node:crypto';

import pg from 'pg';

const BASE = process.env.CARL_SMOKE_BASE ?? 'http://localhost:3100';
const PEPPER = process.env.CARL_DEVICE_SECRET_PEPPER;
const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function post(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // An HTML error page or a redirect body. The status is what matters.
  }
  return { status: response.status, json, text };
}

const client = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20_000,
});

try {
  await client.connect();

  // --- A tenant, a branch, a product and a terminal, through the real functions ---------
  const suffix = randomUUID().slice(0, 8);
  const adminId = randomUUID();
  await client.query(`insert into auth.users (id, email) values ($1, $2)`, [
    adminId,
    `smoke-${suffix}@carl.test`,
  ]);
  await client.query(
    `insert into public.profiles (id, email, full_name) values ($1, $2, 'Smoke Admin')`,
    [adminId, `smoke-${suffix}@carl.test`],
  );
  await client.query(`insert into public.platform_admins (user_id) values ($1)`, [adminId]);
  await client.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: adminId, role: 'authenticated' }),
  ]);

  const { rows: provisioned } = await client.query(
    `select tenant_id, branch_id from public.provision_tenant(
       $1, 'Smoke Test Shop', $2, 'Smoke Admin', $3, 'Main', 'main', 'ACTIVE', 14)`,
    [`smoke-${suffix}`, `smoke-${suffix}@carl.test`, adminId],
  );
  const { tenant_id: tenantId, branch_id: branchId } = provisioned[0];

  const { rows: productRows } = await client.query(
    `insert into public.products (tenant_id, name, sku) values ($1, 'Smoke Rice', $2)
     returning id`,
    [tenantId, `SMOKE-${suffix}`],
  );
  const productId = productRows[0].id;
  await client.query(
    `insert into public.product_prices (tenant_id, product_id, tier, amount)
     values ($1, $2, 'RETAIL', 8000)`,
    [tenantId, productId],
  );
  await client.query(
    `select * from public.apply_stock_adjustment($1, $2, 50, 'OPENING_STOCK', 'Smoke')`,
    [branchId, productId],
  );

  const { rows: deviceRows } = await client.query(
    `insert into public.devices (tenant_id, branch_id, code, name)
     values ($1, $2, 'smoke-pos', 'Smoke Till') returning id`,
    [tenantId, branchId],
  );
  const deviceId = deviceRows[0].id;
  const { rows: codeRows } = await client.query(
    `select code from public.issue_activation_code($1, $2, 24)`,
    [deviceId, PEPPER],
  );
  const activationCode = codeRows[0].code;

  // --- 1. The routes are reachable at all ----------------------------------------------
  const unreachable = await post('/api/device/activate', {});
  record(
    'Terminal routes are not redirected to sign-in',
    unreachable.status !== 307 && unreachable.status !== 302,
    `status ${unreachable.status}`,
  );

  // --- 2. Validation ---------------------------------------------------------------------
  record(
    'A malformed activation is rejected, not redirected',
    unreachable.status === 400 && unreachable.json?.error === 'VALIDATION_FAILED',
    `status ${unreachable.status}, ${unreachable.json?.error ?? unreachable.text.slice(0, 40)}`,
  );

  const wrongCode = await post('/api/device/activate', {
    code: 'ZZZZZZZZZZZZ',
    installId: `install-${suffix}`,
  });
  record(
    'A wrong activation code is refused',
    wrongCode.status === 401,
    `status ${wrongCode.status}, ${wrongCode.json?.error}`,
  );

  // --- 3. Activation ---------------------------------------------------------------------
  const installId = `install-${suffix}`;
  const activated = await post('/api/device/activate', { code: activationCode, installId });
  const session = activated.json;
  record(
    'A terminal activates and receives its secret',
    activated.status === 200 && typeof session?.deviceSecret === 'string',
    `status ${activated.status}`,
  );
  record(
    'Activation names the business and the branch',
    session?.tenantName === 'Smoke Test Shop' && session?.branchName === 'Main',
    `${session?.tenantName} / ${session?.branchName}`,
  );

  // Idempotency: the same install id must not be told the code is consumed.
  const retried = await post('/api/device/activate', { code: activationCode, installId });
  record(
    'Retrying activation returns a session rather than stranding the installer',
    retried.status === 200 && typeof retried.json?.deviceSecret === 'string',
    `status ${retried.status}`,
  );
  const secret = retried.json?.deviceSecret ?? session?.deviceSecret;

  // --- 4. Catalogue ----------------------------------------------------------------------
  const catalogue = await post('/api/device/catalogue', {
    deviceId: session.deviceId,
    deviceSecret: secret,
  });
  record(
    'The terminal downloads its catalogue',
    catalogue.status === 200 && Array.isArray(catalogue.json?.products),
    `status ${catalogue.status}, ${catalogue.json?.products?.length ?? 0} products`,
  );
  record(
    'The catalogue carries no supplier cost',
    !JSON.stringify(catalogue.json ?? {}).includes('average_cost'),
  );

  const wrongSecret = await post('/api/device/catalogue', {
    deviceId: session.deviceId,
    deviceSecret: 'x'.repeat(64),
  });
  record(
    'A wrong device secret is refused',
    wrongSecret.status === 401,
    `status ${wrongSecret.status}, ${wrongSecret.json?.error}`,
  );

  // --- 5. Sync ---------------------------------------------------------------------------
  const noCashier = await post('/api/device/sync', {
    deviceId: session.deviceId,
    deviceSecret: secret,
    idempotencyKey: randomUUID(),
    branchId,
    soldAt: new Date().toISOString(),
    items: [{ product_id: productId, quantity: 1 }],
    payments: [{ method: 'CASH', amount: 8000 }],
  });
  record(
    'A sale with no cashier token is refused',
    noCashier.status === 400,
    `status ${noCashier.status}, ${noCashier.json?.error}`,
  );

  const forgedCashier = await post('/api/device/sync', {
    deviceId: session.deviceId,
    deviceSecret: secret,
    accessToken: 'not-a-real-token-but-long-enough-to-pass',
    idempotencyKey: randomUUID(),
    branchId,
    soldAt: new Date().toISOString(),
    items: [{ product_id: productId, quantity: 1 }],
    payments: [{ method: 'CASH', amount: 8000 }],
  });
  record(
    'A forged cashier token does not produce a sale',
    forgedCashier.status >= 400,
    `status ${forgedCashier.status}, ${forgedCashier.json?.error}`,
  );

  const { rows: saleCount } = await client.query(
    `select count(*)::text as count from public.sales where branch_id = $1`,
    [branchId],
  );
  record(
    'No sale was recorded by any refused request',
    saleCount[0].count === '0',
    `${saleCount[0].count} sales`,
  );

  // --- Cleanup ---------------------------------------------------------------------------
  // Truncation is not available here (other data may exist), and the tenant cannot be
  // hard-deleted because its audit log is append-only. Closing it is the supported path.
  await client.query(
    `update public.tenants set status = 'CANCELLED', cancelled_at = now() where id = $1`,
    [tenantId],
  );
} finally {
  // Cleanup failures must not mask the result of the checks above.
  await client.query(`select set_config('request.jwt.claims', '', false)`).catch(() => undefined);
  await client.end().catch(() => undefined);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exitCode = failed.length > 0 ? 1 : 0;
