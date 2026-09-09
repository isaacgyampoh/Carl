import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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
    ['/api/device/', 'terminals, which have no browser session'],
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
      '/api/device/',
      '/api/health',
      '/auth',
      '/manifest.webmanifest',
      '/offline',
      '/sign-in',
      '/sw.js',
    ]);
  });

  it('excludes the device routes from nothing in the matcher', () => {
    // The matcher decides whether middleware runs at all. If a device route were excluded
    // there instead of allowed here, the session refresh would be skipped too — a subtler
    // difference, and not the one intended.
    const matcher = source.slice(source.indexOf('matcher:'));
    expect(matcher).not.toContain('api/device');
  });
});
