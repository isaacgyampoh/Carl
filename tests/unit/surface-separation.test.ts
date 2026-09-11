import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServerClient } from '../../apps/web/node_modules/@supabase/ssr';

import {
  OWNER_SESSION_COOKIE,
  SURFACE_HEADER,
  surfaceFor,
  surfaceFromHeader,
} from '../../apps/web/src/lib/surface';

/**
 * The owner console and a business are separate applications on one origin.
 *
 * The regression: with one session cookie for the whole site, a PIN typed at a shop's door on
 * the owner's device replaced the owner's session. Opening the console next, the owner was
 * that shop's staff, bounced to /no-access, and led from there to the business dashboard. An
 * installed app on Android and desktop shares the browser's cookies, so the till app did the
 * same to the console, and the console to the till.
 */
const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const WEB = ['apps', 'web', 'src'];

describe('which application a request belongs to', () => {
  it.each(['/', '/platform', '/platform/clients', '/platform/clients/abc', '/platform/settings'])(
    '%s is the owner console',
    (path) => {
      expect(surfaceFor(path)).toBe('owner');
    },
  );

  it.each([
    '/pos',
    '/dashboard',
    '/sign-in',
    '/no-access',
    '/windows-pos',
    '/offline',
    '/api/device/sync',
    '/bobo',
    '/bobo/pos',
    '/bobo/enter',
    // Prefixes that merely start with the same letters are not the console.
    '/platformx',
    '/platform-shop',
  ])('%s is a business', (path) => {
    expect(surfaceFor(path)).toBe('business');
  });

  it('accepts only the exact value the proxy writes', () => {
    expect(surfaceFromHeader('owner')).toBe('owner');
    for (const value of ['OWNER', ' owner', 'platform', '', null, undefined]) {
      expect(surfaceFromHeader(value)).toBe('business');
    }
  });
});

describe('each application reads only its own session cookie', () => {
  /*
   * Behavioural, against the real @supabase/ssr client: a session stored under one cookie
   * name is invisible to a client configured for the other.
   */
  const URL = 'https://example.supabase.co';
  const BUSINESS_COOKIE = 'sb-example-auth-token';
  const session = {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: '00000000-0000-4000-8000-000000000001',
      aud: 'authenticated',
      role: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  };
  const stored = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;

  const clientFor = (jar: { name: string; value: string }[], cookieName?: string) =>
    createServerClient(URL, 'anon-key-for-tests', {
      ...(cookieName ? { cookieOptions: { name: cookieName } } : {}),
      cookies: { getAll: () => jar, setAll: () => undefined },
    });

  const userIn = async (client: ReturnType<typeof clientFor>) =>
    (await client.auth.getSession()).data.session?.user.id ?? null;

  it("a business's session is not the owner's", async () => {
    const jar = [{ name: BUSINESS_COOKIE, value: stored }];
    expect(await userIn(clientFor(jar))).toBe(session.user.id);
    expect(await userIn(clientFor(jar, OWNER_SESSION_COOKIE))).toBeNull();
  });

  it("the owner's session is not a business's", async () => {
    const jar = [{ name: OWNER_SESSION_COOKIE, value: stored }];
    expect(await userIn(clientFor(jar, OWNER_SESSION_COOKIE))).toBe(session.user.id);
    expect(await userIn(clientFor(jar))).toBeNull();
  });

  it('both can be signed in on one device at once', async () => {
    const jar = [
      { name: BUSINESS_COOKIE, value: stored },
      { name: OWNER_SESSION_COOKIE, value: stored },
    ];
    expect(await userIn(clientFor(jar))).not.toBeNull();
    expect(await userIn(clientFor(jar, OWNER_SESSION_COOKIE))).not.toBeNull();
    expect(OWNER_SESSION_COOKIE.startsWith('sb-')).toBe(false);
  });
});

describe('the surface is decided on the server and wired through every session read', () => {
  const proxy = read(...WEB, 'proxy.ts');

  it('the proxy decides it from the path and overwrites whatever the browser sent', () => {
    expect(proxy).toContain('const surface = surfaceFor(pathname)');
    expect(proxy).toContain('forwarded.set(SURFACE_HEADER, surface)');
    expect(proxy).not.toMatch(/headers\.get\(SURFACE_HEADER\)/);
    expect(SURFACE_HEADER).toBe('x-carl-surface');
  });

  it('the proxy refreshes the session of that surface', () => {
    expect(proxy).toContain(
      "...(surface === 'owner' ? { cookieOptions: { name: OWNER_SESSION_COOKIE } } : {})",
    );
  });

  it('the render code reads the session of that surface', () => {
    const client = read(...WEB, 'lib', 'supabase.ts');
    expect(client).toContain("surface === 'owner' ? { name: OWNER_SESSION_COOKIE } : {}");
    expect(client).toContain('surfaceFromHeader((await headers()).get(SURFACE_HEADER))');
  });

  it('a PIN signs in only on its own application', () => {
    expect(read(...WEB, 'server', 'platform-auth-actions.ts')).toContain(
      "(await currentSurface()) !== 'owner'",
    );
    expect(read(...WEB, 'server', 'member-auth-actions.ts')).toContain(
      "(await currentSurface()) !== 'business'",
    );
  });

  it('signing out ends only the application it was pressed in', () => {
    const signOut = read(...WEB, 'server', 'session-actions.ts');
    expect(signOut).toMatch(/if \(surface === 'owner'\) \{\s*await client\.auth\.signOut\(\);/);
  });
});

describe('a business cannot reach the owner console by changing the address', () => {
  it('a signed-out console request goes to the owner PIN at the main address', () => {
    const proxy = read(...WEB, 'proxy.ts');
    expect(proxy).toMatch(/if \(surface === 'owner'\) \{\s*signIn\.pathname = '\/';/);
  });

  it('every console screen is behind the owner guard, in its own route group', () => {
    expect(existsSync(join(ROOT, ...WEB, 'app', '(owner)', 'platform', 'page.tsx'))).toBe(true);
    expect(existsSync(join(ROOT, ...WEB, 'app', '(app)', 'platform'))).toBe(false);
    expect(read(...WEB, 'app', '(owner)', 'layout.tsx')).toContain(
      'const auth = await requirePlatformAdmin();',
    );
    expect(read(...WEB, 'lib', 'auth.ts')).toContain(
      "if (!auth?.user.isPlatformAdmin) redirect('/');",
    );
  });

  it("the business shell carries none of the console, and the console's none of a business", () => {
    const shell = read(...WEB, 'components', 'app-shell.tsx');
    const business = shell.slice(
      shell.indexOf('export function AppShell('),
      shell.indexOf('export function OwnerShell('),
    );
    expect(business).not.toContain('PLATFORM_NAV');
    expect(business).not.toContain('isPlatformAdmin');
    expect(business).toContain('home="/dashboard"');
    const owner = shell.slice(
      shell.indexOf('export function OwnerShell('),
      shell.indexOf('function Shell('),
    );
    expect(owner).not.toContain('NAV_SECTIONS');
    expect(owner).toContain('home="/platform"');
    expect(owner).toContain('tenant={null}');
  });
});
