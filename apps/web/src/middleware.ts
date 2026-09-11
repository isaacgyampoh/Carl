import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Session refresh and route protection.
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
 */
/**
 * Read directly from `process.env` rather than through the shared config module: middleware
 * runs in the Edge runtime, and pulling in the infrastructure package would drag the
 * browser Supabase client along with it.
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

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    requiredEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requiredEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookies) => {
          for (const { name, value } of cookies) {
            request.cookies.set(name, value);
          }
          // A fresh response is required so the rotated cookies are actually sent; mutating
          // the previous one after reading from it drops them.
          response = NextResponse.next({ request });
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

  const { pathname } = request.nextUrl;

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
     * The owner's PIN prompt.
     *
     * It has to be reachable without a session for the obvious reason: it is how the
     * session is obtained. Behind the session check it would redirect to the merchant
     * sign-in page, which asks for an email and password the platform owner does not use.
     */
    pathname === '/platform/sign-in' ||
    // The owner console's manifest. A browser fetches it before any session exists, and
    // behind the session check it returns a redirect, so the app cannot be installed.
    pathname === '/platform.webmanifest' ||
    /*
     * The public site.
     *
     * Exactly `/` and nothing under it: a prefix match here would make the entire
     * application public, which is the opposite of what this list is for.
     */
    pathname === '/' ||
    // Browsers post CSP violation reports themselves, without cookies, often for the
    // sign-in page where there is no session at all. Behind the session check the reports
    // would be redirected and silently lost.
    pathname === '/api/csp-report' ||
    pathname === '/offline' ||
    pathname === '/sw.js' ||
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
  const isShopManifest =
    rest.length === 0 &&
    fileSegment === 'manifest.webmanifest' &&
    shopSegment !== undefined &&
    SLUG.test(shopSegment) &&
    !RESERVED.has(shopSegment);

  if (!user && !isPublic && !isShopEntry && !isShopManifest) {
    const signIn = request.nextUrl.clone();
    /*
     * The owner console has its own way in.
     *
     * Sending an unauthenticated owner to the merchant sign-in page is a dead end: it asks
     * for an email and password, and the platform owner signs in with a PIN. The guard in
     * requirePlatformAdmin() says the same thing, but middleware runs first, so saying it
     * only there means it never runs.
     */
    signIn.pathname = pathname.startsWith('/platform') ? '/platform/sign-in' : '/sign-in';
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
