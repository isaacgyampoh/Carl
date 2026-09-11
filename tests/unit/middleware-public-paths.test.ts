import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which paths bypass the session check.
 *
 * This list is short and every entry is load-bearing in a way that is invisible until it
 * is wrong, because the failure is always the same shape: a redirect to `/sign-in` from
 * something that cannot use `/sign-in`.
 *
 *   `/offline`     — the page shown when there is no connection. Redirecting it sends the
 *                    user to a sign-in page that also cannot load, so they see a browser
 *                    error instead of an explanation.
 *   `/sw.js`       — the service worker can never register or update, disabling offline
 *                    support entirely.
 *   `/api/device/` — a till has no cookie. Behind the session check, every activation and
 *                    every sync in the estate is redirected and nothing works.
 *
 * Asserted against the source rather than a running server so it is a fast, always-run
 * gate. The route-level authorization those endpoints perform is tested separately.
 */
describe('middleware public paths', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', '..', 'apps', 'web', 'src', 'proxy.ts'),
    'utf8',
  );

  const publicBlock = source.slice(source.indexOf('const isPublic'), source.indexOf('if (!user'));

  it.each([
    ['/sign-in', 'the sign-in page itself'],
    ['/auth', 'the OAuth callback'],
    ['/api/health', 'the liveness probe'],
    ['/', "the owner's entry, which is how the owner's session is obtained"],
    ['/api/device/', 'terminals, which have no browser session'],
    ['/api/csp-report', 'browsers post violation reports without cookies'],
    ['/offline', 'the page shown when there is no connection'],
    ['/sw.js', 'the service worker'],
    ['/manifest.webmanifest', "the till app's generic manifest"],
    ['/find-shop', 'where a till opens when this device has not signed in to a business yet'],
  ])('%s is public — %s', (path) => {
    expect(publicBlock).toContain(`'${path}'`);
  });

  it('does not make anything else public', () => {
    // A guard against the list quietly growing. Adding a path here is a deliberate act,
    // and it should require changing this test.
    const paths = [...publicBlock.matchAll(/'(\/[^']*)'/g)].map((match) => match[1]);
    expect(paths.sort()).toEqual([
      '/',
      '/api/csp-report',
      '/api/device/',
      '/api/health',
      '/auth',
      '/find-shop',
      '/manifest.webmanifest',
      '/offline',
      '/sign-in',
      '/sw.js',
    ]);
  });

  it("sends an unauthenticated owner to the owner's PIN at the main address", () => {
    /*
     * Middleware runs before any page guard, so a redirect decided only in
     * requirePlatformAdmin() never happens. Without this branch the owner is bounced to a
     * page asking for an email and password they do not have.
     */
    const redirectBlock = source.slice(source.indexOf('if (!user && !isPublic'));
    expect(redirectBlock).toMatch(/if \(surface === 'owner'\) \{\s*signIn\.pathname = '\/';/);
  });

  it("sends the owner's old PIN address to the main address", () => {
    expect(source).toMatch(
      /if \(pathname === '\/platform\/sign-in'\) \{[\s\S]*?entry\.pathname = '\/';/,
    );
  });

  it('excludes the device routes from nothing in the matcher', () => {
    // The matcher decides whether middleware runs at all. If a device route were excluded
    // there instead of allowed here, the session refresh would be skipped too — a subtler
    // difference, and not the one intended.
    const matcher = source.slice(source.indexOf('matcher:'));
    expect(matcher).not.toContain('api/device');
  });
});

/**
 * Shop URLs versus the application's own routes.
 *
 * `/{slug}` must be reachable without a session, because it is how a shop's staff obtain
 * one. It is matched by shape, since slugs are customers' business names created at
 * runtime — and that shape also matches `/pos`, `/products`, `/inventory` and every other
 * single-segment route in the application.
 *
 * Without the reserved list, the entire merchant application would be served to anyone.
 * These tests exist so that adding a route without reserving it fails here rather than in
 * production.
 */
describe('shop entry URLs do not expose the application', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', '..', 'apps', 'web', 'src', 'proxy.ts'),
    'utf8',
  );

  const reserved = (() => {
    const match = /const RESERVED = new Set\(\[([\s\S]*?)\]\)/.exec(source);
    if (!match) throw new Error('The reserved route list is gone from middleware.');
    return new Set([...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!));
  })();

  const shape = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

  /** Every top-level route directory that actually exists on disk. */
  const actualRoutes = (() => {
    const appDir = join(import.meta.dirname, '..', '..', 'apps', 'web', 'src', 'app');
    const names = new Set<string>();
    const groups = readdirSync(appDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('('))
      .map((entry) => entry.name);
    for (const group of [...groups, '.']) {
      const dir = join(appDir, group);
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (
          entry.name.startsWith('(') ||
          entry.name.startsWith('[') ||
          entry.name.startsWith('_')
        ) {
          continue;
        }
        names.add(entry.name);
      }
    }
    return [...names];
  })();

  it.each(actualRoutes)('/%s is reserved, not treated as a shop', (route) => {
    // If this fails, that route is being served to unauthenticated visitors.
    if (!shape.test(route)) return; // cannot collide with a slug anyway
    expect(reserved.has(route), `/${route} would be public`).toBe(true);
  });

  describe("a shop's manifest", () => {
    /*
     * The regression: `/{slug}/manifest.webmanifest` was behind the session check. A browser
     * fetches the manifest before anyone signs in, got a redirect to /sign-in, and cannot
     * install from a redirect — so every shop's install button silently did nothing, while
     * the manifest itself built and served correctly to anyone already signed in.
     */
    it('is let through without a session', () => {
      expect(source).toContain('!isShopManifest');
      expect(source).toMatch(
        /if \(!user && !isPublic && !isShopEntry && !isShopManifest && !isShopPosDoor\)/,
      );
    });

    it('matches exactly two segments, never a prefix of the shop', () => {
      // A prefix would make everything under a shop's address public, including /new-pin.
      expect(source).toContain('rest.length === 0');
      expect(source).toContain("fileSegment === 'manifest.webmanifest'");
    });

    it('keeps the RESERVED guard on the shop half', () => {
      // Otherwise /pos/manifest.webmanifest and friends would slip past the check.
      expect(source).toMatch(/SLUG\.test\(shopSegment\)\s*&&\s*!RESERVED\.has\(shopSegment\)/);
    });
  });

  describe("a business's till door", () => {
    // Where the installed POS app starts, so it must open without a session, exactly like the
    // business's own address — and only at exactly two segments.
    it('is exactly /{slug}/pos, with the reserved guard on the business half', () => {
      expect(source).toContain(
        "const isShopPosDoor = rest.length === 0 && fileSegment === 'pos' && isShopAddress;",
      );
      expect(source).toMatch(
        /const isShopAddress =\s*shopSegment !== undefined && SLUG\.test\(shopSegment\) && !RESERVED\.has\(shopSegment\);/,
      );
    });
  });

  it('still lets a real business slug through', () => {
    for (const slug of ['abc-fashion', 'kofi-stores', 'shop123']) {
      expect(shape.test(slug) && !reserved.has(slug), `${slug} would not reach its shop`).toBe(
        true,
      );
    }
  });

  /**
   * Names held back deliberately, with no route behind them.
   *
   * A reserved name costs nothing and prevents a shop from claiming a slug the application
   * may want later — `carl-red.vercel.app/settings` belonging to a merchant called
   * "Settings" would be a confusing thing to undo once their staff have learned the URL.
   *
   * Everything NOT in this set must correspond to a real route directory, so a stale entry
   * cannot quietly accumulate and mislead the next person reading the list.
   */
  // `settings` used to be held back here with no route behind it. The client business
  // settings page now exists, so, as the test below demands, the exception is gone.
  const RESERVED_WITHOUT_ROUTE = new Set<string>([]);

  it('reserves nothing that does not exist, except where deliberate', () => {
    const onDisk = new Set(actualRoutes);
    const stale = [...reserved].filter((r) => !onDisk.has(r) && !RESERVED_WITHOUT_ROUTE.has(r));
    expect(stale, 'reserved routes with no directory').toEqual([]);
  });

  it('does not hold back a name that now has a route', () => {
    // If /settings is ever built, this fails and the exception above must be removed —
    // otherwise the list stops describing reality again.
    const onDisk = new Set(actualRoutes);
    const nowReal = [...RESERVED_WITHOUT_ROUTE].filter((r) => onDisk.has(r));
    expect(nowReal, 'held-back names that now have routes').toEqual([]);
  });
});
