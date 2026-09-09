/**
 * Verifies the desktop bundle before Tauri is allowed to embed it.
 *
 * ## Why this runs on every build rather than being a test
 *
 * A release `.app` once shipped with a placeholder `index.html` built hours earlier, whose
 * `<script type="module">` imported `@tauri-apps/plugin-sql` as a bare specifier. WebKit
 * has no module resolver, so the first sign of it was:
 *
 *     Module name, '@tauri-apps/plugin-sql' does not resolve to a valid URL
 *
 * on a running application. Nothing else caught it: the TypeScript compiled, the tests
 * passed, and `tauri build` bundled the stale directory without complaint.
 *
 * So this is a build step, not a test. It runs inside `pnpm build`, which is now
 * `beforeBuildCommand`, so a bundle that cannot work in a WebView never reaches a `.app`.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'desktop', 'dist');
const failures = [];
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

if (!existsSync(DIST)) {
  console.error(`✗ No bundle at ${DIST}. Run "pnpm --filter @carl/desktop build".`);
  process.exit(1);
}

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const assets = existsSync(join(DIST, 'assets')) ? readdirSync(join(DIST, 'assets')) : [];
const scripts = assets.filter((f) => f.endsWith('.js'));

check('the bundle contains JavaScript', scripts.length > 0, `${scripts.length} script(s)`);

// The exact failure that shipped: an entry point that was never bundled.
check(
  'index.html does not reference unbundled source',
  !/src=["']\/src\//.test(html),
  'it points at /src/, so Vite never built it',
);

check(
  'index.html loads a built asset',
  /src=["'][^"']*assets\/[^"']+\.js["']/.test(html),
  'no built entry script is referenced',
);

const code = scripts.map((f) => readFileSync(join(DIST, 'assets', f), 'utf8')).join('\n');

/**
 * Bare specifiers, which a browser cannot resolve.
 *
 * Matched only in import/export positions: the plain package name appears legitimately in
 * comments and error strings, and failing on those would make this check something people
 * work around rather than trust.
 */
const bareImport = /(?:^|[\s;}])(?:import|export)[^;'"]*from\s*["'](?!\.{0,2}\/|https?:|data:)([^"']+)["']/gm;
const bare = [...code.matchAll(bareImport)].map((m) => m[1]);
check(
  'no bare module specifiers survive bundling',
  bare.length === 0,
  bare.length > 0 ? `WebKit cannot resolve: ${[...new Set(bare)].join(', ')}` : '',
);

check(
  'no bare dynamic imports survive bundling',
  !/import\(\s*["'](?!\.{0,2}\/|https?:|data:)[^"']+["']\s*\)/.test(code),
);

// Positive evidence, not just the absence of a problem: the SQL plugin must be present as
// the IPC calls it compiles to. A bundle missing these has no database at all.
for (const command of ['plugin:sql|load', 'plugin:sql|execute', 'plugin:sql|select']) {
  check(`the SQL plugin is bundled (${command})`, code.includes(command));
}

// Secrets must never be baked into a bundle that ships to a shop counter.
for (const [name, pattern] of [
  ['no service-role key', /SUPABASE_SERVICE_ROLE|service_role.{0,40}eyJ/],
  ['no database URL', /postgres(?:ql)?:\/\/[^"'\s]+:[^"'@\s]+@/],
  ['no device secret pepper', /CARL_DEVICE_SECRET_PEPPER/],
]) {
  check(name, !pattern.test(code));
}

for (const { name, ok, detail } of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} bundle check(s) failed. Refusing to ship this frontend.`);
  process.exit(1);
}
console.log(`\n${checks.length} bundle checks passed.`);
