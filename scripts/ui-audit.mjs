/**
 * Every screen Carl has, at phone, tablet and desktop size, against the staging demo shop.
 *
 * Saves a screenshot of each and reports what can be measured rather than argued about:
 *
 *   Layout        content wider than the screen, text too small to read on a counter tablet,
 *                 tap targets too small for a thumb.
 *   Reachability  a control with no accessible name, an image with no alt text, a field with
 *                 no label, a heading level skipped, two elements sharing one id. A cashier
 *                 using a screen reader or a keyboard meets these as dead ends.
 *   Contrast      text below the WCAG AA ratio for its size, computed against the colour
 *                 actually painted behind it.
 *   Weight        bytes and requests per screen, because a till is opened on a phone in a
 *                 market and every kilobyte is somebody's data bundle.
 *
 * Needs a Carl serving the staging project, and staging's own keys:
 *
 *   set -a; . ~/.carl/staging.env; set +a
 *   BASE=http://localhost:3100 SB_URL=$STAGING_SUPABASE_URL SB_ANON=$STAGING_ANON_KEY \
 *     SB_SERVICE=$STAGING_SERVICE_ROLE_KEY SUPABASE_DB_URL=$SUPABASE_DB_URL \
 *     OUT=/tmp/carl-audit pnpm ui:audit
 *
 * Never point it at production: it signs in as the platform owner and as a shop's
 * administrator to see the screens behind them.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Resolved from this file, not from an absolute path on somebody's laptop.
const require = createRequire(import.meta.url);
const requireWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { Client } = require('pg');
const { createServerClient } = requireWeb('@supabase/ssr');

const {
  BASE = 'http://localhost:3100',
  SB_URL,
  SB_ANON,
  SB_SERVICE,
  SUPABASE_DB_URL,
  OUT,
} = process.env;
const SLUG = 'mama-akos';

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, mobile: true, scale: 3 },
  { name: 'tablet', width: 834, height: 1112, mobile: true, scale: 2 },
  { name: 'desktop', width: 1440, height: 900, mobile: false, scale: 1 },
];

/** Screens worth looking at, and who has to be signed in to see them. */
const SCREENS = [
  ['owner-entry', '/', 'none'],
  ['find-shop', '/find-shop', 'none'],
  ['shop-door', `/${SLUG}`, 'none'],
  ['pos-door', `/${SLUG}/pos`, 'none'],
  ['dashboard', '/dashboard', 'business'],
  ['pos', '/pos', 'business'],
  ['products', '/products', 'business'],
  ['product-new', '/products/new', 'business'],
  ['inventory', '/inventory', 'business'],
  ['sales', '/sales', 'business'],
  ['customers', '/customers', 'business'],
  ['reports', '/reports', 'business'],
  ['day-report', '/reports/day', 'business'],
  ['expenses', '/expenses', 'business'],
  ['register', '/register', 'business'],
  ['staff', '/staff', 'business'],
  ['branches', '/branches', 'business'],
  ['settings', '/settings', 'business'],
  ['windows-pos', '/windows-pos', 'business'],
  ['devices', '/devices', 'business'],
  ['platform', '/platform', 'owner'],
  ['platform-clients', '/platform/clients', 'owner'],
  ['platform-onboarding', '/platform/onboarding', 'owner'],
  ['platform-billing', '/platform/billing', 'owner'],
  ['platform-devices', '/platform/devices', 'owner'],
  ['platform-health', '/platform/health', 'owner'],
  ['platform-settings', '/platform/settings', 'owner'],
];

// ---- sessions, minted the way the server does after a PIN ----
const adminApi = async (path, method = 'GET', body) => {
  const res = await fetch(`${SB_URL}/auth/v1/admin${path}`, {
    method,
    headers: {
      apikey: SB_SERVICE,
      authorization: `Bearer ${SB_SERVICE}`,
      'content-type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
};
async function cookiesFor(email, cookieName) {
  const link = await adminApi('/generate_link', 'POST', { type: 'magiclink', email });
  const hashed = link.hashed_token ?? link.properties?.hashed_token;
  const tokens = await fetch(`${SB_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: SB_ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashed }),
  }).then((r) => r.json());
  const jar = [];
  const client = createServerClient(SB_URL, SB_ANON, {
    ...(cookieName ? { cookieOptions: { name: cookieName } } : {}),
    cookies: {
      getAll: () => jar,
      setAll: (items) => {
        for (const i of items) if (i.value) jar.push({ name: i.name, value: i.value });
      },
    },
  });
  await client.auth.setSession({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  });
  return jar;
}

const db = new Client({ connectionString: SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const ownerId = (await db.query('select user_id from public.platform_admins limit 1')).rows[0]
  .user_id;
const merchantId = (
  await db.query(
    `select m.user_id from public.tenant_memberships m join public.tenants t on t.id = m.tenant_id
   where t.slug = $1 and m.is_owner limit 1`,
    [SLUG],
  )
).rows[0].user_id;
const tenantId = (await db.query('select id from public.tenants where slug = $1', [SLUG])).rows[0]
  .id;
const ownerEmail = (await adminApi(`/users/${ownerId}`)).email;
const merchantEmail = (await adminApi(`/users/${merchantId}`)).email;
await db.end();

const ownerCookies = await cookiesFor(ownerEmail, 'carl-owner-session');
const businessCookies = await cookiesFor(merchantEmail, null);

// ---- browser ----
const root = join(process.env.HOME, 'Library/Caches/ms-playwright');
const build = readdirSync(root)
  .filter((d) => /^chromium-\d+$/.test(d))
  .sort()
  .at(-1);
const exe = join(
  root,
  build,
  readdirSync(join(root, build), { recursive: true }).find((p) =>
    /MacOS\/(Chromium|Google Chrome for Testing)$/.test(String(p)),
  ),
);
const chrome = spawn(
  exe,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'carl-ui-'))}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
const wsUrl = await new Promise((res, rej) => {
  let out = '';
  chrome.stderr.on('data', (d) => {
    out += d;
    const m = /DevTools listening on (ws:\S+)/.exec(out);
    if (m) res(m[1]);
  });
  setTimeout(() => rej(new Error('browser did not start')), 30000);
});
const ws = new WebSocket(wsUrl);
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
      pending.delete(id);
      rej(new Error(`no reply to ${method}`));
    }, 45000);
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
const host = new URL(BASE).hostname;
for (const cookie of [...ownerCookies, ...businessCookies]) {
  await send('Storage.setCookies', {
    cookies: [
      {
        name: cookie.name,
        value: cookie.value,
        domain: host,
        path: '/',
        secure: false,
        sameSite: 'Lax',
        expires: Math.floor(Date.now() / 1000) + 7200,
      },
    ],
  });
}
// The business this session is working in, as the server sets after a PIN.
await send('Storage.setCookies', {
  cookies: [
    {
      name: 'carl_tenant',
      value: tenantId,
      domain: host,
      path: '/',
      secure: false,
      sameSite: 'Lax',
      expires: Math.floor(Date.now() / 1000) + 7200,
    },
  ],
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
for (const domain of [
  'Page.enable',
  'Runtime.enable',
  'Network.enable',
  'Emulation.setFocusEmulationEnabled',
]) {
  await send(domain, domain.startsWith('Emulation') ? { enabled: true } : {}, sessionId);
}

// Every screen pays full price, so the weight reported is what a shop's first visit costs.
await send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);

/** What the screen being measured has pulled down so far. */
let traffic = { bytes: 0, requests: 0 };
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Network.loadingFinished') {
    traffic.bytes += m.params.encodedDataLength || 0;
    traffic.requests += 1;
  }
});
const evaluate = async (expression) =>
  (
    await send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    )
  ).result.value;

/** Measured in the page: the faults a person would call "the layout is broken". */
const MEASURE = `(() => {
  const vw = window.innerWidth;
  const faults = [];
  const doc = document.scrollingElement;
  if (doc.scrollWidth > vw + 1) faults.push({ kind: 'page scrolls sideways', detail: doc.scrollWidth + 'px wide in ' + vw + 'px' });
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || el.offsetParent === null) continue;
    // Decoration is not content: a backdrop's washes are deliberately bigger than the screen
    // and clipped by their container. Nothing here is read, tapped, or scrolled to.
    if (el.closest('[aria-hidden="true"]')) continue;
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const tag = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : '');
    if (box.width > vw + 1 && !seen.has('wide:' + tag)) { seen.add('wide:' + tag); faults.push({ kind: 'element wider than the screen', detail: tag + ' ' + Math.round(box.width) + 'px' }); }
    if (box.right > vw + 1 && box.left >= 0 && !seen.has('spill:' + tag) && style.overflowX !== 'auto' && style.overflowX !== 'scroll') { seen.add('spill:' + tag); faults.push({ kind: 'content spills past the right edge', detail: tag + ' ends at ' + Math.round(box.right) + 'px' }); }
    const size = parseFloat(style.fontSize);
    if (el.textContent && el.textContent.trim().length > 3 && size && size < 12 && !seen.has('small:' + tag)) { seen.add('small:' + tag); faults.push({ kind: 'text below 12px', detail: tag + ' ' + size + 'px' }); }
    const interactive = ['a', 'button', 'input', 'select', 'textarea'].includes(el.tagName.toLowerCase()) || el.getAttribute('role') === 'button';
    // A checkbox is 20 points by design; what must be tappable is the label around it.
    const label = el.closest('label');
    const target = label ? label.getBoundingClientRect() : box;
    if (interactive && window.matchMedia('(pointer: coarse)').matches && (target.height < 40 || target.width < 40) && !seen.has('tap:' + tag)) {
      seen.add('tap:' + tag);
      faults.push({ kind: 'tap target under 40px', detail: tag + ' ' + Math.round(box.width) + '×' + Math.round(box.height) });
    }

    // ---- reachability: a control nobody can name is a control nobody can use ----
    const role = el.getAttribute('role');
    const named = (node) => {
      const label = node.getAttribute('aria-label');
      if (label && label.trim()) return true;
      if (node.getAttribute('aria-labelledby')) return true;
      if (node.getAttribute('title')) return true;
      if ((node.textContent || '').trim()) return true;
      if (node.id && document.querySelector('label[for="' + CSS.escape(node.id) + '"]')) return true;
      if (node.closest('label')) return true;
      const alt = node.querySelector('img[alt]:not([alt=""])');
      return Boolean(alt);
    };
    if (interactive && !named(el) && !seen.has('name:' + tag)) {
      seen.add('name:' + tag);
      faults.push({ kind: 'control with no accessible name', detail: tag });
    }
    if (el.tagName === 'IMG' && el.getAttribute('alt') === null && !seen.has('alt:' + tag)) {
      seen.add('alt:' + tag);
      faults.push({ kind: 'image with no alt attribute', detail: tag + ' ' + (el.getAttribute('src') || '').slice(0, 60) });
    }

    // ---- contrast, against the colour actually painted behind the text ----
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (ownText) {
      /*
       * Colours are read by painting them, not by parsing them.
       *
       * Carl's palette is written in oklch, and getComputedStyle hands back 'oklch(0.21 0.015
       * 255)' — which an rgb parser reads as red 0.21, green 0.015, blue 255. The first
       * version of this check did exactly that and reported every screen in the product as
       * failing at about 1.5:1. A 1x1 canvas gives the sRGB bytes a screen actually shows, for
       * oklch, color-mix, named colours and everything else.
       */
      const paint = window.__carlPaint || (window.__carlPaint = (() => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        return (css) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = '#000';
          ctx.fillStyle = css;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
          return { r, g, b, a: a / 255 };
        };
      })());
      const lum = ({ r, g, b }) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };

      let node = el, bg = null, painted = true;
      while (node && node.nodeType === 1) {
        const s = getComputedStyle(node);
        // A picture behind the text: the ratio depends on the pixel, so it is not measurable
        // here and is judged by eye instead.
        if (s.backgroundImage && s.backgroundImage !== 'none') { painted = false; break; }
        const c = paint(s.backgroundColor);
        if (c.a > 0.95) { bg = c; break; }
        node = node.parentElement;
      }
      const fg = paint(style.color);
      if (painted && bg && fg.a > 0.5) {
        const l1 = lum(fg), l2 = lum(bg);
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        const bold = Number(style.fontWeight) >= 700;
        const large = size >= 24 || (bold && size >= 18.66);
        const need = large ? 3 : 4.5;
        if (ratio < need && !seen.has('contrast:' + tag)) {
          seen.add('contrast:' + tag);
          faults.push({ kind: 'contrast below AA', detail: tag + ' ' + ratio.toFixed(2) + ':1, needs ' + need + ':1' });
        }
      }
    }
  }

  // ---- document-level: headings and ids ----
  const ids = new Map();
  for (const el of document.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) || 0) + 1);
  for (const [id, n] of ids) if (n > 1) faults.push({ kind: 'duplicate id', detail: id + ' ×' + n });

  const levels = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .filter((h) => h.offsetParent !== null)
    .map((h) => Number(h.tagName[1]));
  if (levels.length && levels.filter((l) => l === 1).length === 0) {
    faults.push({ kind: 'no first-level heading', detail: 'starts at h' + levels[0] });
  }
  for (let i = 1; i < levels.length; i += 1) {
    if (levels[i] - levels[i - 1] > 1) {
      faults.push({ kind: 'heading level skipped', detail: 'h' + levels[i - 1] + ' → h' + levels[i] });
      break;
    }
  }

  return { faults, title: document.title, path: location.pathname };
})()`;

/*
 * Before trusting a clean report, prove the checks can fail.
 *
 * A page carrying one of every fault this script looks for is measured first. If the checks
 * do not all fire on it, the run stops: "0 faults" from a broken measurement is worse than no
 * measurement at all, because it is believed.
 */
const CANARY =
  `data:text/html,` +
  encodeURIComponent(`
  <body style="background:#fff">
    <h2>Heading that should have been an h1</h2>
    <h4>Level skipped</h4>
    <p style="color:#bbb;font-size:14px">Text too pale to read</p>
    <p style="font-size:9px">Text far too small</p>
    <button></button>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
    <div id="twice"></div><div id="twice"></div>
    <div style="width:3000px">wider than any screen</div>
  </body>`);
await send(
  'Emulation.setDeviceMetricsOverride',
  { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
  sessionId,
);
await send('Page.navigate', { url: CANARY }, sessionId);
await new Promise((r) => setTimeout(r, 600));
const canary = await evaluate(MEASURE);
const caught = new Set((canary.faults ?? []).map((f) => f.kind));
const MUST_CATCH = [
  'page scrolls sideways',
  'element wider than the screen',
  'text below 12px',
  'control with no accessible name',
  'image with no alt attribute',
  'contrast below AA',
  'duplicate id',
  'no first-level heading',
  'heading level skipped',
];
const missed = MUST_CATCH.filter((kind) => !caught.has(kind));
if (missed.length > 0) {
  console.error('The audit cannot see these faults, so it cannot report their absence:');
  for (const kind of missed) console.error('  ' + kind);
  ws.close();
  chrome.kill();
  process.exit(2);
}
console.log(`Checks verified against a page built to fail all ${MUST_CATCH.length} of them.\n`);

mkdirSync(OUT, { recursive: true });
const report = [];
for (const viewport of VIEWPORTS) {
  mkdirSync(join(OUT, viewport.name), { recursive: true });
  await send(
    'Emulation.setDeviceMetricsOverride',
    {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.mobile,
    },
    sessionId,
  );
  // maxTouchPoints must be 1 or more even when touch is switched off.
  await send(
    'Emulation.setTouchEmulationEnabled',
    { enabled: viewport.mobile, maxTouchPoints: 5 },
    sessionId,
  );
  for (const [name, path] of SCREENS.map((s) => [s[0], s[1]])) {
    traffic = { bytes: 0, requests: 0 };
    await send('Page.navigate', { url: BASE + path }, sessionId);
    await new Promise((r) => setTimeout(r, 2200));
    let measured;
    try {
      measured = await evaluate(MEASURE);
    } catch {
      measured = { faults: [{ kind: 'page did not answer', detail: '' }], path: '?' };
    }
    const shot = await send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: true },
      sessionId,
    );
    writeFileSync(join(OUT, viewport.name, `${name}.png`), Buffer.from(shot.data, 'base64'));
    const weight = { ...traffic };
    for (const fault of measured.faults ?? [])
      report.push({
        viewport: viewport.name,
        screen: name,
        landed: measured.path,
        weight,
        ...fault,
      });
    if ((measured.faults ?? []).length === 0)
      report.push({
        viewport: viewport.name,
        screen: name,
        landed: measured.path,
        weight,
        kind: 'ok',
        detail: '',
      });
  }
}
ws.close();
chrome.kill();

const problems = report.filter((r) => r.kind !== 'ok');
console.log(
  `${report.filter((r) => r.kind === 'ok').length} screens clean, ${problems.length} faults\n`,
);
for (const row of problems)
  console.log(`${row.viewport.padEnd(8)} ${row.screen.padEnd(20)} ${row.kind} — ${row.detail}`);

// The ten heaviest screens on a phone, which is the connection that can least afford them.
const phone = report.filter((r) => r.viewport === 'phone' && r.weight);
const heaviest = [...new Map(phone.map((r) => [r.screen, r.weight])).entries()]
  .sort((a, b) => b[1].bytes - a[1].bytes)
  .slice(0, 10);
if (heaviest.length) {
  // The first screen visited pays for the shell; the rest are served by the service worker,
  // which is exactly what a shop's second screen of the day costs.
  console.log(
    '\nBytes over the network on a phone (first screen cold, the rest through the worker)',
  );
  for (const [screen, w] of heaviest) {
    console.log(
      `  ${screen.padEnd(22)} ${(w.bytes / 1024).toFixed(0).padStart(6)} KB  ${String(w.requests).padStart(3)} requests`,
    );
  }
}

writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
process.exitCode = problems.length > 0 ? 1 : 0;
