import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { DOOR_COOKIE, isPosScreen, shopDoor } from './lib/shop-door';
import {
  movedTo,
  OWNER_SESSION_COOKIE,
  SURFACE_HEADER,
  surfaceForRequest,
  type Hosts,
} from './lib/surface';

/**
 * Session refresh and route protection.
 *
 * Named `proxy` because Next.js 16 renamed the `middleware` file convention; the behaviour is
 * unchanged. It still runs before every matched request.
 *
 * ## What this is for
 *
 * Supabase access tokens are short-lived. Without a refresh on each request, a user is
 * signed out mid-shift — which on a POS means mid-sale. This runs before every matched
 * request, refreshes the token, and writes the rotated cookies onto the response.
 *
 * ## What this is NOT
 *
 * It is not Carl's authorization. Middleware answers "is there a valid session"; Row Level
 * Security answers "may this person see this row". A redirect here is a convenience that
 * keeps signed-out users off application pages, and nothing more — bypassing it reaches a
 * database that still refuses the request.
 *
 * `getUser()` is used rather than `getSession()` because only the former validates the
 * token with the auth server. `getSession()` decodes whatever the cookie contains, and a
 * forged cookie decodes perfectly well.
 *
 * ## Which application a request belongs to
 *
 * Decided here, from the path alone (lib/surface.ts): the owner console (`/` and
 * `/platform/...`) or a business (its portal and its till). Each keeps its own session cookie,
 * and the decision reaches the render code in a request header this proxy always overwrites.
 */
/**
 * Read directly from `process.env` rather than through the shared config module: the proxy
 * runs apart from the render code, where Next.js advises against relying on shared modules,
 * and pulling in the infrastructure package would drag the browser Supabase client along.
 *
 * A missing value throws with a message naming the variable. The alternative — a non-null
 * assertion — surfaces as an opaque 401 on every request instead.
 */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env.local and fill it in.`);
  }
  return value;
}

/** A hostname from configuration. Absent and empty mean the same thing: not configured. */
function configuredHost(name: string): string | null {
  const value = process.env[name]?.trim().toLowerCase();
  return value !== undefined && value.length > 0 ? value : null;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = request.headers.get('host') ?? '';
  /*
   * Configured, these split the two applications across two hostnames: the console answers on
   * one, businesses and their tills on the other. Unset, Carl runs on a single hostname and the
   * path decides, which is how it has always worked.
   */
  const hosts: Hosts = {
    owner: configuredHost('CARL_OWNER_HOST'),
    app: configuredHost('CARL_APP_HOST'),
  };
  const surface = surfaceForRequest(pathname, host, hosts);

  // A console address asked for on the shops' hostname, or the other way round.
  const elsewhere = movedTo(pathname, host, hosts);
  if (elsewhere) {
    const moved = new URL(elsewhere);
    moved.search = request.nextUrl.search;
    return NextResponse.redirect(moved);
  }

  /*
   * The owner's old PIN page.
   *
   * The owner's entry is the main address now. This one lives on in bookmarks and in "Carl
   * Owner" apps installed before the move, and sends them to the entry that replaced it.
   */
  if (pathname === '/platform/sign-in') {
    const entry = request.nextUrl.clone();
    entry.pathname = '/';
    entry.search = '';
    return NextResponse.redirect(entry);
  }

  // Replaced, never appended: a browser that sends its own surface header changes nothing.
  const forwardedHeaders = () => {
    const forwarded = new Headers(request.headers);
    forwarded.set(SURFACE_HEADER, surface);
    return forwarded;
  };

  let response = NextResponse.next({ request: { headers: forwardedHeaders() } });

  const supabase = createServerClient(
    requiredEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requiredEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      // The owner console's session is its own; a business uses Supabase's default cookie.
      ...(surface === 'owner' ? { cookieOptions: { name: OWNER_SESSION_COOKIE } } : {}),
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookies) => {
          for (const { name, value } of cookies) {
            request.cookies.set(name, value);
          }
          // A fresh response is required so the rotated cookies are actually sent; mutating
          // the previous one after reading from it drops them.
          response = NextResponse.next({ request: { headers: forwardedHeaders() } });
          for (const { name, value, options } of cookies) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  /*
   * Routes that must work without a session.
   *
   * `/offline` and `/sw.js` are here for a specific reason: both are reached precisely
   * when the browser cannot talk to the server. Requiring authentication for the offline
   * page means it redirects to sign-in — which also cannot load — so the user sees a
   * browser error instead of an explanation. Requiring it for the service worker means the
   * worker can never register or update, which disables offline support entirely.
   *
   * Both were caught by requesting every route against a running server; neither would
   * have shown up in a build or a type check.
   */
  const isPublic =
    pathname.startsWith('/sign-in') ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/api/health') ||
    /*
     * The terminal endpoints.
     *
     * These are NOT unprotected — they are protected by something a browser session cannot
     * express. A till carries a device secret, and `/api/device/sync` additionally carries
     * the cashier's own access token; both are verified inside the database functions the
     * routes call. What a till does not have is a cookie, so leaving these behind the
     * session check redirects every activation and every sync to `/sign-in`, and no
     * terminal in the estate can reach Carl at all.
     */
    pathname.startsWith('/api/device/') ||
    /*
     * The owner's entry: the main address, where the platform owner types their PIN.
     *
     * It has to be reachable without a session because it is how that session is obtained.
     * Exactly `/` and nothing under it: a prefix match here would make the entire
     * application public, which is the opposite of what this list is for.
     */
    pathname === '/' ||
    // Browsers post CSP violation reports themselves, without cookies, often for the
    // sign-in page where there is no session at all. Behind the session check the reports
    // would be redirected and silently lost.
    pathname === '/api/csp-report' ||
    // Where someone opens their till when this device has not signed in to a business yet.
    pathname === '/find-shop' ||
    pathname === '/offline' ||
    pathname === '/sw.js' ||
    // The till app's generic manifest. A browser fetches a manifest before anyone signs in.
    pathname === '/manifest.webmanifest';

  /*
   * A shop's own front door: `/{slug}`.
   *
   * Matched by shape, because slugs are customers' business names created at runtime and
   * cannot be listed ahead of time. It has to be reachable without a session for the same
   * reason the owner's PIN page does: it is how a session is obtained.
   *
   * RESERVED is what makes that safe. Without it every single-segment route in the
   * application — /pos, /products, /inventory, /reports — matches the shape of a slug and
   * would be served to anyone, unauthenticated. That is not a subtle failure: it is the
   * whole merchant application becoming public. `middleware-public-paths.test.ts` fails if
   * a new top-level route is added and not listed here.
   *
   * `/{slug}/new-pin` is deliberately not covered: it requires a session, and the page
   * guards itself.
   */
  const RESERVED = new Set([
    'api',
    'auth',
    'branches',
    'customers',
    'dashboard',
    'devices',
    'expenses',
    'find-shop',
    'inventory',
    'no-access',
    'offline',
    'platform',
    'pos',
    'products',
    'purchases',
    'register',
    'reports',
    'sales',
    'settings',
    'sign-in',
    'staff',
    'suppliers',
    'transfers',
    'windows-pos',
  ]);
  const segment = pathname.slice(1);
  const SLUG = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
  const isShopEntry = SLUG.test(segment) && !RESERVED.has(segment) && !isPublic;

  /*
   * A shop's own manifest: exactly `/{slug}/manifest.webmanifest`, nothing else under a slug.
   *
   * A browser fetches the manifest before anyone has signed in — that is the point of it —
   * and behind the session check this path answered with a redirect to /sign-in. The browser
   * cannot install from a redirect, so every shop's install button silently did nothing: the
   * per-business manifest existed, built, and was unreachable by the only client that asks
   * for it.
   *
   * Two segments, matched in full. A prefix match on the slug would make everything a shop
   * owns under its address public, and `/{slug}/new-pin` in particular requires a session.
   * The slug half carries the same RESERVED guard as the front door, so `/pos/manifest...`
   * and friends stay behind the check.
   */
  // Split on a regex rather than a quoted slash: middleware-public-paths.test.ts treats every
  // single-quoted string beginning with a slash in this block as a public path, and that is
  // the right guard to keep.
  const [shopSegment, fileSegment, ...rest] = segment.split(/\//);
  const isShopAddress =
    shopSegment !== undefined && SLUG.test(shopSegment) && !RESERVED.has(shopSegment);
  const isShopManifest =
    rest.length === 0 && fileSegment === 'manifest.webmanifest' && isShopAddress;
  /*
   * A business's till door: exactly `/{slug}/pos`, where the installed POS app starts.
   *
   * Public for the same reason as the business's own address: it is where a cashier's session
   * is obtained. Two segments, matched in full, with the same RESERVED guard.
   */
  const isShopPosDoor = rest.length === 0 && fileSegment === 'pos' && isShopAddress;

  if (!user && !isPublic && !isShopEntry && !isShopManifest && !isShopPosDoor) {
    const signIn = request.nextUrl.clone();
    /*
     * The owner console has its own way in: the owner's PIN at the main address.
     *
     * Sending an unauthenticated owner to the merchant sign-in page is a dead end: it asks
     * for an email and password, and the platform owner signs in with a PIN. The guard in
     * requirePlatformAdmin() says the same thing, but middleware runs first, so saying it
     * only there means it never runs.
     */
    if (surface === 'owner') {
      signIn.pathname = '/';
      signIn.search = '';
    } else {
      /*
       * A screen that belongs to a business goes back to that business's PIN door, not to the
       * email sign-in page a PIN user cannot use. See lib/shop-door.ts.
       */
      const door = shopDoor(
        pathname,
        request.cookies.get(DOOR_COOKIE)?.value,
        (segment) => SLUG.test(segment) && !RESERVED.has(segment),
      );
      if (door) {
        signIn.pathname = door;
        signIn.search = '';
        return NextResponse.redirect(signIn);
      }
      /*
       * A till screen on a device that has never signed in to a business. The email-and-password
       * page is no use to a cashier who has only ever had a PIN, so this asks which business it
       * is and hands them that business's own door.
       */
      if (isPosScreen(pathname)) {
        signIn.pathname = '/find-shop';
        signIn.search = '';
        return NextResponse.redirect(signIn);
      }
      signIn.pathname = '/sign-in';
    }
    // Preserved so a deep link survives the round trip through sign-in.
    signIn.searchParams.set('next', pathname);
    return NextResponse.redirect(signIn);
  }

  if (user && pathname.startsWith('/sign-in')) {
    const home = request.nextUrl.clone();
    home.pathname = '/dashboard';
    home.search = '';
    return NextResponse.redirect(home);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and images. Running middleware on those would add a
     * token refresh to every icon request for no benefit.
     */
    '/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)',
  ],
};
