// Carl's entry architecture, proved against a running deployment.
//
// Owner PIN at the main address leads to the console and nowhere else; a till door leads to the
// till; a business address leads to the portal; the console and a till hold separate sessions on
// one device; and no business session can reach the console by changing the address.
//
// It creates a temporary business through the same calls onboarding and the Staff page make,
// drives the real doors with real PINs in a fresh browser profile, and prints PASS/FAIL per flow.
// Nothing about a PIN, token, cookie, email or id is ever printed.
//
// Run it against STAGING, never production:
//   BASE=… SB_URL=… SB_ANON=… SB_SERVICE=… SUPABASE_DB_URL=… node tests/e2e/routing.mjs
//
// With no staging environment configured it skips, so a pull request from a fork is not a
// failure for want of secrets.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Resolved from the repository rather than from an absolute path: this runs on a CI runner too.
const require = createRequire(import.meta.url);
const requireFromWeb = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { Client } = require('pg');
const { createClient } = requireFromWeb('@supabase/supabase-js');
const { createServerClient } = requireFromWeb('@supabase/ssr');

const required = ['BASE', 'SB_URL', 'SB_ANON', 'SB_SERVICE', 'SUPABASE_DB_URL'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.log(`SKIPPED — no staging environment configured (missing ${missing.join(', ')})`);
  process.exit(0);
}
if (/carl-red\.vercel\.app|thecarl\.cc/.test(process.env.BASE ?? '')) {
  console.error('REFUSED — this suite creates and deletes a business; point it at staging.');
  process.exit(2);
}

const {
  BASE,
  SB_URL,
  SB_ANON,
  SB_SERVICE,
  STATE_FILE = 'e2e-state.json',
  ROLE_KEY = 'cashier',
} = process.env;
const REF = new URL(SB_URL).hostname.split('.')[0];
const BUSINESS_COOKIE = `sb-${REF}-auth-token`;
const OWNER_COOKIE = 'carl-owner-session';

const tally = { pass: 0, fail: 0, nt: 0 };
const PROGRESS = process.env.PROGRESS_FILE;
const log = (line) => {
  console.log(line);
  if (PROGRESS) appendFileSync(PROGRESS, line + '\n');
};
const step = (what) => {
  if (PROGRESS) appendFileSync(PROGRESS, `  … ${new Date().toISOString().slice(11, 19)} ${what}\n`);
};
const out = (flow, ok, label, detail = '') => {
  tally[ok === null ? 'nt' : ok ? 'pass' : 'fail']++;
  log(
    `${ok === null ? 'NOT TESTED' : ok ? 'PASS' : 'FAIL'}  [${flow}] ${label}${detail ? ' — ' + detail : ''}`,
  );
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- Auth + data helpers (service key only ever in memory) ----------------
const adminApi = async (path, method = 'GET', body) => {
  const r = await fetch(`${SB_URL}/auth/v1/admin${path}`, {
    method,
    headers: {
      apikey: SB_SERVICE,
      authorization: `Bearer ${SB_SERVICE}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const mintSession = async (email) => {
  const link = await adminApi('/generate_link', 'POST', { type: 'magiclink', email });
  const hashed = link.json.hashed_token ?? link.json.properties?.hashed_token;
  const v = await fetch(`${SB_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: SB_ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashed }),
  });
  return v.json();
};
const asUser = (token) =>
  createClient(SB_URL, SB_ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
const goodPin = (exclude) => {
  for (;;) {
    const d = [...randomBytes(4)].map((b) => b % 10);
    const pin = d.join('');
    const distinct = new Set(d).size === 4;
    const run =
      d.every((x, i) => i === 0 || x === d[i - 1] + 1) ||
      d.every((x, i) => i === 0 || x === d[i - 1] - 1);
    if (distinct && !run && !exclude.includes(pin) && !/^19|^20/.test(pin)) return pin;
  }
};

// ---------------- Browser (CDP) ----------------
/*
 * The browser. Playwright's download cache on either platform, or CHROMIUM_PATH when the runner
 * put it somewhere else. Raw CDP from here on: this drives real navigations and real cookies,
 * which is the whole point of an end-to-end test of routing.
 */
function chromiumBinary() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const roots = [
    join(process.env.HOME ?? '', 'Library/Caches/ms-playwright'),
    join(process.env.HOME ?? '', '.cache/ms-playwright'),
  ].filter((dir) => existsSync(dir));
  for (const root of roots) {
    const builds = readdirSync(root)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort();
    for (const build of builds.reverse()) {
      const found = readdirSync(join(root, build), { recursive: true }).find((p) =>
        /(MacOS\/(Chromium|Google Chrome for Testing)|chrome-linux\/chrome)$/.test(String(p)),
      );
      if (found) return join(root, build, String(found));
    }
  }
  throw new Error('no Chromium found: run `npx playwright install chromium`, or set CHROMIUM_PATH');
}
const exe = chromiumBinary();
const chrome = spawn(
  exe,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'carl-e2e-'))}`,
    '--no-first-run',
    '--no-default-browser-check',
    // A CI runner has no user namespace to sandbox into, and /dev/shm is too small there.
    '--no-sandbox',
    '--disable-dev-shm-usage',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
const ws = new WebSocket(
  await new Promise((res, rej) => {
    let output = '';
    chrome.stderr.on('data', (chunk) => {
      output += chunk;
      const found = /DevTools listening on (ws:\S+)/.exec(output);
      if (found) res(found[1]);
    });
    chrome.on('exit', (code) =>
      rej(new Error(`the browser exited (${code}): ${output.slice(-400)}`)),
    );
    // Without this the run hangs on an unsettled await and says nothing about why.
    setTimeout(
      () => rej(new Error(`the browser did not start within 30s: ${output.slice(-400)}`)),
      30_000,
    );
  }),
);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (!m.id || !pending.has(m.id)) return;
  const p = pending.get(m.id);
  pending.delete(m.id);
  if (m.error) p.rej(new Error(m.error.message));
  else p.res(m.result);
});
const send = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rej(new Error(`no reply to ${method} within 30s`));
      }
    }, 30000);
    pending.set(id, {
      res: (v) => {
        clearTimeout(timer);
        res(v);
      },
      rej: (e) => {
        clearTimeout(timer);
        rej(e);
      },
    });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const open = async (url) => {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const d of ['Page.enable', 'Runtime.enable', 'Network.enable']) await send(d, {}, sessionId);
  await send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  const tab = { targetId, s: sessionId };
  if (url) await go(tab, url);
  return tab;
};
const close = (tab) =>
  send('Target.closeTarget', { targetId: tab.targetId }).catch(() => undefined);
const evaluate = async (tab, expression) => {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        tab.s,
      );
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    } catch (e) {
      if (i === 19) throw e;
      await sleep(500);
    }
  }
};
const settle = async (tab) => {
  let last = '',
    stable = 0;
  for (let i = 0; i < 60 && stable < 3; i++) {
    await sleep(500);
    const now = await evaluate(tab, `document.readyState + '|' + location.href`).catch(() => '');
    stable = now === last && now.startsWith('complete') ? stable + 1 : 0;
    last = now;
  }
};
const go = async (tab, url) => {
  step(`open ${url.replace(BASE, '')}`);
  await send('Page.navigate', { url }, tab.s);
  await settle(tab);
};
const path = (tab) => evaluate(tab, 'location.pathname');
const href = (tab) => evaluate(tab, 'location.pathname + location.search');
const bodyText = (tab) => evaluate(tab, 'document.body ? document.body.innerText : ""');
const waitPath = async (tab, pred, ms = 25000) => {
  const end = Date.now() + ms;
  let p = '';
  while (Date.now() < end) {
    p = await path(tab).catch(() => '');
    if (pred(p)) {
      await settle(tab);
      return p;
    }
    await sleep(400);
  }
  return p;
};
const manifest = async (tab) => {
  const m = await send('Page.getAppManifest', {}, tab.s).catch(() => ({}));
  let data = {};
  try {
    data = JSON.parse(m.data || '{}');
  } catch {
    // No manifest, or one this browser could not parse. Either way: none.
  }
  return { url: (m.url || '').replace(BASE, ''), ...data };
};
const typePin = (tab, pin) => (
  step('type a PIN'),
  evaluate(
    tab,
    `(() => { const i = document.querySelector('input[aria-label="PIN"]'); if (!i) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(pin)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
  )
);
const setNewPin = (tab, pin) =>
  evaluate(
    tab,
    `(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; for (const n of ['newPin', 'confirmPin']) { const i = document.querySelector('input[name="' + n + '"]'); set.call(i, ${JSON.stringify(pin)}); i.dispatchEvent(new Event('input', { bubbles: true })); } document.querySelector('input[name="newPin"]').form.requestSubmit(); return true; })()`,
  );
const click = (tab, text) =>
  evaluate(
    tab,
    `(() => { const el = [...document.querySelectorAll('button, a')].find((e) => e.textContent.trim() === ${JSON.stringify(text)} && e.offsetParent !== null); if (!el) return false; el.click(); return true; })()`,
  );
const hasLink = (tab, target) => evaluate(tab, `!!document.querySelector('a[href="${target}"]')`);
const HOST = new URL(BASE).hostname;
const cookieNames = async () =>
  (await send('Storage.getCookies', {})).cookies.filter(
    (c) => c.domain.replace(/^\./, '') === HOST,
  );
const putCookie = (name, value, expires) =>
  send('Storage.setCookies', {
    cookies: [{ name, value, domain: HOST, path: '/', secure: true, sameSite: 'Lax', expires }],
  });
const clearBusinessSession = async () => {
  for (const c of await cookieNames())
    if (c.name === BUSINESS_COOKIE || c.name.startsWith(BUSINESS_COOKIE + '.'))
      await putCookie(c.name, '', 1);
  const left = (await cookieNames()).filter(
    (c) => c.name === BUSINESS_COOKIE || c.name.startsWith(BUSINESS_COOKIE + '.'),
  );
  if (left.length) throw new Error('could not clear the business session cookie');
};
const businessAccessToken = async () => {
  const parts = (await cookieNames())
    .filter((c) => c.name === BUSINESS_COOKIE || c.name.startsWith(BUSINESS_COOKIE + '.'))
    .sort(
      (a, b) => (Number(a.name.split('.').pop()) || 0) - (Number(b.name.split('.').pop()) || 0),
    );
  const raw = parts.map((c) => c.value).join('');
  return JSON.parse(
    Buffer.from(decodeURIComponent(raw).replace(/^base64-/, ''), 'base64url').toString(),
  ).access_token;
};
const passGate = async (tab) => {
  if ((await bodyText(tab)).includes('Continue in this browser')) {
    await click(tab, 'Continue in this browser');
    await sleep(800);
  }
};

const tabRef = { current: null };
const pg = new Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await pg.connect();

/**
 * Takes away everything this run created.
 *
 * The suite makes a business, an administrator and a cashier every time; left behind they pile
 * up in staging until nothing about a failure is legible. Accounts go through the Auth admin
 * API, never by deleting auth.users rows, and the tenant's immutability guards are suspended
 * only inside this transaction.
 */
const createdAccounts = [];
let createdTenant = null;
async function teardown() {
  const guards = [
    ['audit_logs', 'audit_logs_immutable'],
    ['cash_movements', 'cash_movements_immutable'],
    ['inventory_movements', 'inventory_movements_immutable'],
    ['subscription_payments', 'subscription_payments_immutable'],
  ];
  if (createdTenant) {
    const tables = (
      await pg.query(`select c.relname t from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
        where n.nspname = 'public' and c.relkind = 'r' order by 1`)
    ).rows.map((r) => r.t);
    await pg.query('begin');
    try {
      for (const [table, trigger] of guards) {
        await pg.query(`alter table public.${table} disable trigger ${trigger}`);
      }
      for (const table of tables) {
        await pg.query(`delete from public.${table} where tenant_id = $1`, [createdTenant]);
      }
      await pg.query(`delete from public.tenants where id = $1`, [createdTenant]);
      for (const [table, trigger] of guards) {
        await pg.query(`alter table public.${table} enable trigger ${trigger}`);
      }
      await pg.query('commit');
    } catch (e) {
      await pg.query('rollback');
      log(`NOTE  the temporary business could not be removed: ${String(e.message).slice(0, 80)}`);
    }
  }
  for (const id of createdAccounts) {
    await fetch(`${SB_URL}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: SB_SERVICE, authorization: `Bearer ${SB_SERVICE}` },
    }).catch(() => undefined);
  }
}
try {
  // ================= Setup: one temporary business =================
  const [{ user_id: ownerId }] = (
    await pg.query('select user_id from public.platform_admins limit 1')
  ).rows;
  const ownerEmail = (await adminApi(`/users/${ownerId}`)).json.email;
  const ownerTokens = await mintSession(ownerEmail);
  out(
    'Setup',
    !!ownerTokens.access_token,
    'short-lived owner test session created through the Auth admin API',
  );
  const tag = randomBytes(3).toString('hex');
  const slug = `routing-test-${tag}`;
  writeFileSync(STATE_FILE, JSON.stringify({ slug }), { mode: 0o600 });
  const adminEmail = `routing-test-${tag}@example.com`;
  const adminAcct = await adminApi('/users', 'POST', {
    email: adminEmail,
    email_confirm: true,
    password: randomUUID() + randomUUID(),
    user_metadata: { full_name: 'Routing Test Admin' },
  });
  if (adminAcct.json?.id) createdAccounts.push(adminAcct.json.id);
  const ownerDb = asUser(ownerTokens.access_token);
  const { data: plan } = await ownerDb
    .from('subscription_plans')
    .select('id')
    .eq('is_active', true)
    .order('sort_order')
    .limit(1)
    .maybeSingle();
  const { data: ob, error: obError } = await ownerDb.rpc('onboard_client', {
    p_business_name: 'Carl Routing Test',
    p_slug: slug,
    p_owner_email: adminEmail,
    p_owner_name: 'Routing Test Admin',
    p_owner_user_id: adminAcct.json.id,
    p_plan_id: plan.id,
    p_branch_name: 'Main Branch',
    p_branch_code: 'main',
    p_trial_days: 14,
  });
  out(
    'Setup',
    !obError && ob?.length === 1,
    `temporary business ${slug} onboarded by the owner (onboard_client)`,
    obError ? obError.message : '',
  );
  if (obError) throw new Error('setup failed');
  const tenantId = ob[0].tenant_id,
    branchId = ob[0].branch_id;
  createdTenant = tenantId;
  const { data: pinRows } = await ownerDb.rpc('issue_initial_pin', { p_tenant_id: tenantId });
  const initialPin = pinRows?.[0]?.out_pin;
  out(
    'Setup',
    /^\d{4}$/.test(initialPin ?? ''),
    "business administrator's starting PIN issued (not shown)",
  );

  const tab = await open();
  tabRef.current = tab;

  // ================= Signed out: entries, manifests, service worker =================
  await go(tab, `${BASE}/manifest.webmanifest`);
  await evaluate(
    tab,
    `caches.open('carl-v1-shell').then((c) => c.put('/manifest.webmanifest', new Response('{"start_url":"/"}'))).then(() => caches.keys())`,
  );
  await go(tab, `${BASE}/`);
  out(
    'A: owner entry',
    (await path(tab)) === '/',
    'the main address serves the owner entry, signed out',
  );
  const entryText = await bodyText(tab);
  out(
    'A: owner entry',
    entryText.includes('Owner console') &&
      (await evaluate(tab, `!!document.querySelector('input[aria-label="PIN"]')`)),
    'it asks for the owner PIN',
  );
  out('PWA', !(await manifest(tab)).url, 'the main address offers no installable app');
  const swScript = await evaluate(
    tab,
    `navigator.serviceWorker.ready.then((r) => r.active.scriptURL.replace(location.origin, ''))`,
  );
  let keys = [];
  for (let i = 0; i < 30; i++) {
    keys = await evaluate(tab, 'caches.keys()');
    if (!keys.includes('carl-v1-shell') && keys.includes('carl-v2-shell')) break;
    await sleep(500);
  }
  out(
    'Service worker',
    swScript === '/sw.js' &&
      (await evaluate(
        tab,
        `fetch('/sw.js', { cache: 'no-store' }).then((r) => r.text()).then((t) => t.includes("'carl-v2'"))`,
      )),
    'the deployed worker is version carl-v2 and is active',
  );
  out(
    'Service worker',
    !keys.includes('carl-v1-shell') && keys.includes('carl-v2-shell'),
    'an old carl-v1 cache holding a stale manifest is deleted on activation',
    `caches: ${keys.join(', ')}`,
  );

  for (const [from, want] of [
    ['/platform', '/'],
    ['/platform/clients', '/'],
    ['/platform/sign-in', '/'],
    ['/dashboard', '/sign-in'],
    ['/pos', '/sign-in'],
  ]) {
    await go(tab, BASE + from);
    const p = await path(tab);
    out('Signed out', p === want, `${from} → ${want}`, p);
  }

  await go(tab, `${BASE}/${slug}/pos`);
  const posManifest = await manifest(tab);
  const installErrors = (
    await send('Page.getInstallabilityErrors', {}, tab.s)
  ).installabilityErrors.map((e) => e.errorId);
  out(
    'PWA',
    posManifest.url === `/${slug}/manifest.webmanifest` &&
      posManifest.name === `Carl POS · ${slug}` &&
      posManifest.start_url === `/${slug}/pos` &&
      posManifest.id === `/${slug}` &&
      posManifest.scope === '/',
    "the till door's app is Carl POS, starting at this business's till door",
    `${posManifest.name} start_url=${posManifest.start_url} id=${posManifest.id}`,
  );
  out(
    'PWA',
    installErrors.length === 0,
    'Chromium reports the POS app installable',
    installErrors.join(', ') || 'no errors',
  );
  out(
    'PWA',
    (await bodyText(tab)).includes('Install Carl POS'),
    'the till door says plainly what is installed',
  );
  await go(tab, `${BASE}/${slug}`);
  const portalManifest = await manifest(tab);
  const portalText = await bodyText(tab);
  out(
    'PWA',
    portalManifest.start_url === `/${slug}/pos` && portalManifest.id === `/${slug}`,
    "the business address carries the same POS app identity, so older installs update to the till's start_url",
  );
  out(
    'C: merchant entry',
    !portalText.includes('Continue in this browser') &&
      (await evaluate(tab, `!!document.querySelector('input[aria-label="PIN"]')`)),
    'the business address shows the PIN with no install gate in front of it',
  );

  // ================= C: business administrator → portal =================
  await typePin(tab, initialPin);
  let p = await waitPath(tab, (x) => x.startsWith(`/${slug}/new-pin`));
  out(
    'C: merchant entry',
    p === `/${slug}/new-pin` && !(await href(tab)).includes('to=pos'),
    'first PIN at the business address asks the administrator to choose their own',
    p,
  );
  const adminPin = goodPin([initialPin]);
  await setNewPin(tab, adminPin);
  p = await waitPath(tab, (x) => x === '/dashboard' || x === '/no-access' || x === '/pos');
  out(
    'C: merchant entry',
    p === '/dashboard',
    'after choosing a PIN the administrator lands in the business portal',
    p,
  );
  const dash = (await bodyText(tab)).toLowerCase();
  out(
    'C: merchant entry',
    dash.includes('carl routing test') &&
      !dash.includes('carl platform') &&
      !dash.includes('owner console') &&
      !(await hasLink(tab, '/platform')),
    'the portal is the business shell, with nothing of the owner console',
  );
  const dashManifest = await manifest(tab);
  const dashLinks = await evaluate(
    tab,
    `[...document.querySelectorAll('link[rel="manifest"]')].map((l) => l.getAttribute('href') + (l.closest('head') ? '@head' : '@body')).join(' ')`,
  );
  out(
    'PWA',
    dashManifest.url === `/${slug}/manifest.webmanifest`,
    "the portal's screens offer this business's POS app, not the main website",
    `resolved=${dashManifest.url || '(none)'} links=${dashLinks.replaceAll(slug, '<slug>') || '(none)'}`,
  );
  await click(tab, 'Sign out');
  p = await waitPath(tab, (x) => x === `/${slug}`);
  out('C: merchant entry', p === `/${slug}`, "signing out returns to the business's own door", p);
  await typePin(tab, adminPin);
  p = await waitPath(tab, (x) => x === '/dashboard' || x === '/pos' || x === '/no-access');
  out(
    'C: merchant entry',
    p === '/dashboard',
    'business address → administrator PIN → business portal',
    p,
  );
  await send('Page.reload', {}, tab.s);
  await settle(tab);
  out(
    'C: merchant entry',
    (await path(tab)) === '/dashboard',
    'refreshing the portal stays in the portal',
  );
  for (const target of [
    '/platform',
    '/platform/clients',
    '/platform/onboarding',
    '/platform/settings',
  ]) {
    await go(tab, BASE + target);
    const q = await path(tab);
    const t = await bodyText(tab);
    out(
      'H: isolation',
      q === '/' &&
        t.includes('Owner console') &&
        !t.includes('Add client') &&
        !t.includes('Carl Routing Test'),
      `a business administrator typing ${target} gets only the owner PIN`,
      q,
    );
  }

  // Cashier, added the way the Staff page adds one: an Auth account, then add_staff_member as the administrator.
  await go(tab, `${BASE}/dashboard`);
  const adminToken = await businessAccessToken();
  const cashierAcct = await adminApi('/users', 'POST', {
    email: `staff-${randomUUID()}@staff.carl.invalid`,
    email_confirm: true,
    password: randomUUID() + randomUUID(),
    user_metadata: { full_name: 'Routing Test Cashier' },
  });
  if (cashierAcct.json?.id) createdAccounts.push(cashierAcct.json.id);
  let cashierPin = null,
    staffError = null;
  for (let i = 0; i < 4 && !cashierPin; i++) {
    const candidate = goodPin([initialPin, adminPin]);
    const { error } = await asUser(adminToken).rpc('add_staff_member', {
      p_tenant_id: tenantId,
      p_user_id: cashierAcct.json.id,
      p_full_name: 'Routing Test Cashier',
      p_role_key: ROLE_KEY,
      p_pin: candidate,
      p_branch_ids: [branchId],
    });
    if (error) staffError = error.message;
    else cashierPin = candidate;
  }
  out(
    'Setup',
    !!cashierPin,
    `a ${ROLE_KEY} added by the business administrator (add_staff_member)`,
    cashierPin ? '' : staffError,
  );
  if (!cashierPin) {
    await adminApi(`/users/${cashierAcct.json.id}`, 'DELETE');
    throw new Error('cashier setup failed');
  }
  await click(tab, 'Sign out');
  await waitPath(tab, (x) => x === `/${slug}`);

  // ================= B: cashier → POS =================
  await go(tab, `${BASE}/${slug}/pos`);
  await passGate(tab);
  await typePin(tab, cashierPin);
  p = await waitPath(
    tab,
    (x) =>
      x === '/pos' || x.startsWith(`/${slug}/new-pin`) || x === '/dashboard' || x === '/no-access',
  );
  if (p.startsWith(`/${slug}/new-pin`)) {
    out(
      'B: cashier POS',
      (await href(tab)).includes('to=pos'),
      'a PIN the manager set is replaced first, remembering the till door',
    );
    cashierPin = goodPin([initialPin, adminPin, cashierPin]);
    await setNewPin(tab, cashierPin);
    p = await waitPath(tab, (x) => x === '/pos' || x === '/dashboard' || x === '/no-access');
  }
  out('B: cashier POS', p === '/pos', 'POS door → cashier PIN → POS', p);
  const till = (await bodyText(tab)).toLowerCase();
  out(
    'B: cashier POS',
    !till.includes('carl platform') &&
      !till.includes('owner console') &&
      !(await hasLink(tab, '/platform')),
    'the till shows nothing of the owner console',
  );
  for (const [target, want] of [
    ['/platform', '/'],
    ['/platform/clients', '/'],
    ['/staff', '/no-access'],
    ['/dashboard', '/pos'],
  ]) {
    await go(tab, BASE + target);
    const q = await path(tab);
    const t = await bodyText(tab);
    out(
      'H: isolation',
      q === want && !t.includes('Add client'),
      `a cashier typing ${target} gets ${want === '/' ? 'only the owner PIN' : want}`,
      q,
    );
  }

  // ================= E: close and reopen the POS app =================
  await close(tab);
  let app = await open(`${BASE}/${slug}/pos`);
  tabRef.current = app;
  p = await waitPath(app, (x) => x === '/pos' || x === `/${slug}/pos`);
  out(
    'E: PWA restart',
    p === '/pos',
    'reopening the app at its start_url with a live session goes straight to the till',
    p,
  );
  await go(app, `${BASE}/pos`);
  out(
    'E: PWA restart',
    (await path(app)) === '/pos',
    'the generic POS app start_url (/pos) opens the till too',
  );
  await close(app);
  await clearBusinessSession();
  app = await open(`${BASE}/${slug}/pos`);
  tabRef.current = app;
  p = await path(app);
  await passGate(app);
  out(
    'E: PWA restart',
    p === `/${slug}/pos` &&
      (await evaluate(app, `!!document.querySelector('input[aria-label="PIN"]')`)),
    "reopening after the session ended asks for the PIN at the till's door, not the website",
    p,
  );
  await typePin(app, cashierPin);
  p = await waitPath(app, (x) => x === '/pos' || x === '/dashboard' || x === '/no-access');
  out('E: PWA restart', p === '/pos', 'and the PIN leads back to the till', p);
  await clearBusinessSession();
  await go(app, `${BASE}/pos`);
  p = await path(app);
  out(
    'E: PWA restart',
    p === `/${slug}/pos`,
    "a till screen whose session ended returns to this till's door",
    p,
  );
  await passGate(app);
  await typePin(app, cashierPin);
  await waitPath(app, (x) => x === '/pos');

  // ================= D/F/G: owner console, alongside the signed-in till =================
  const jar = [];
  const ssr = createServerClient(SB_URL, SB_ANON, {
    cookieOptions: { name: OWNER_COOKIE },
    cookies: {
      getAll: () => jar,
      setAll: (items) => {
        for (const i of items) {
          const k = jar.findIndex((c) => c.name === i.name);
          if (k >= 0) jar.splice(k, 1);
          if (i.value) jar.push({ name: i.name, value: i.value });
        }
      },
    },
  });
  await ssr.auth.setSession({
    access_token: ownerTokens.access_token,
    refresh_token: ownerTokens.refresh_token,
  });
  for (const c of jar) await putCookie(c.name, c.value, Math.floor(Date.now() / 1000) + 3600);
  await go(app, `${BASE}/`);
  p = await path(app);
  out(
    'A: owner entry',
    p === '/platform',
    'with an owner session, the main address opens the owner console',
    p,
  );
  const consoleText = (await bodyText(app)).toLowerCase();
  out(
    'A: owner entry',
    consoleText.includes('owner console') &&
      consoleText.includes('carl platform') &&
      !(await hasLink(app, '/pos')) &&
      !(await hasLink(app, '/dashboard')),
    'the console is the owner shell, with no till or business links',
  );
  out('PWA', !(await manifest(app)).url, 'the owner console offers no installable app');
  await send('Page.reload', {}, app.s);
  await settle(app);
  out(
    'D: owner refresh',
    (await path(app)) === '/platform',
    'refreshing the console stays in the console',
  );
  await go(app, `${BASE}/platform/clients`);
  out(
    'F: direct URL',
    (await path(app)) === '/platform/clients' &&
      (await bodyText(app)).includes('Carl Routing Test'),
    'opening /platform/clients directly stays in the console and lists businesses',
  );
  await go(app, `${BASE}/platform/onboarding`);
  out(
    'F: direct URL',
    (await path(app)) === '/platform/onboarding' && (await bodyText(app)).includes('Add client'),
    'opening /platform/onboarding directly shows onboarding',
  );
  await go(app, `${BASE}/pos`);
  out(
    'Separation',
    (await path(app)) === '/pos' && !(await bodyText(app)).toLowerCase().includes('carl platform'),
    "the owner signing in did not replace the till's session on the same device",
  );
  await go(app, `${BASE}/platform`);
  out(
    'Separation',
    (await path(app)) === '/platform',
    "and the till's session did not replace the owner's",
  );
  const clicked = await click(app, 'Sign out');
  p = await waitPath(app, (x) => x === '/');
  out(
    'G: owner logout',
    clicked && p === '/',
    'signing out of the console returns to the owner PIN at the main address',
    p,
  );
  for (const target of ['/platform', '/platform/clients']) {
    await go(app, BASE + target);
    out(
      'G: owner logout',
      (await path(app)) === '/' && !(await bodyText(app)).includes('Carl Routing Test'),
      `after logout, ${target} needs the owner PIN again`,
    );
  }
  await go(app, `${BASE}/pos`);
  out('Separation', (await path(app)) === '/pos', "the owner's logout did not sign the till out");
  out(
    'A: owner entry',
    null,
    'typing the real owner PIN at the main address',
    'left to the owner, by agreement',
  );
} catch (e) {
  out('Run', false, 'aborted', String(e.message).slice(0, 160));
  try {
    log(
      `  at: ${await evaluate(tabRef.current, 'location.pathname + " | " + document.title').catch(() => 'unknown')}`,
    );
  } catch {
    // Best effort: the run is already reporting a failure.
  }
} finally {
  await teardown();
  await pg.end();
  ws.close();
  chrome.kill();
  console.log(`\nROUTING E2E: ${tally.pass} passed, ${tally.fail} failed, ${tally.nt} not tested`);
  process.exit(tally.fail ? 1 : 0);
}
