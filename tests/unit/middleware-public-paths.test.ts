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
    join(import.meta.dirname, '..', '..', 'apps', 'web', 'src', 'middleware.ts'),
    'utf8',
  );

  const publicBlock = source.slice(source.indexOf('const isPublic'), source.indexOf('if (!user'));

  it.each([
    ['/sign-in', 'the sign-in page itself'],
    ['/auth', 'the OAuth callback'],
    ['/api/health', 'the liveness probe'],
    ['/', 'the public site, which is how anybody finds out what Carl is'],
    ['/api/device/', 'terminals, which have no browser session'],
    ['/platform/sign-in', 'the owner PIN prompt, which is how a session is obtained'],
    ['/platform.webmanifest', 'fetched before any session exists, or the PWA cannot install'],
    ['/api/csp-report', 'browsers post violation reports without cookies'],
    ['/offline', 'the page shown when there is no connection'],
    ['/sw.js', 'the service worker'],
    ['/manifest.webmanifest', 'the PWA manifest'],
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
      '/manifest.webmanifest',
      '/offline',
      '/platform.webmanifest',
      '/platform/sign-in',
      '/sign-in',
      '/sw.js',
    ]);
  });

  it('sends an unauthenticated owner to the PIN prompt, not the merchant sign-in', () => {
    /*
     * Middleware runs before any page guard, so a redirect decided only in
     * requirePlatformAdmin() never happens. Without this branch the owner is bounced to a
     * page asking for an email and password they do not have.
     */
    const redirectBlock = source.slice(source.indexOf('if (!user && !isPublic'));
    expect(redirectBlock).toContain("pathname.startsWith('/platform')");
    expect(redirectBlock).toContain("'/platform/sign-in'");
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
    join(import.meta.dirname, '..', '..', 'apps', 'web', 'src', 'middleware.ts'),
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
    for (const group of ['(app)', '.']) {
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

  it('still lets a real business slug through', () => {
    for (const slug of ['abc-fashion', 'kofi-stores', 'shop123']) {
      expect(shape.test(slug) && !reserved.has(slug), `${slug} would not reach its shop`).toBe(
        true,
      );
    }
  });

  it('reserves nothing that does not exist', () => {
    // A stale entry is harmless but misleading: it suggests a route that is not there.
    const onDisk = new Set(actualRoutes);
    const stale = [...reserved].filter((r) => !onDisk.has(r));
    expect(stale, 'reserved routes with no directory').toEqual([]);
  });
});
