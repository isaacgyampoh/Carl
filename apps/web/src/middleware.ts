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
    // Browsers post CSP violation reports themselves, without cookies, often for the
    // sign-in page where there is no session at all. Behind the session check the reports
    // would be redirected and silently lost.
    pathname === '/api/csp-report' ||
    pathname === '/offline' ||
    pathname === '/sw.js' ||
    pathname === '/manifest.webmanifest';

  if (!user && !isPublic) {
    const signIn = request.nextUrl.clone();
    signIn.pathname = '/sign-in';
    // Preserved so a deep link survives the round trip through sign-in.
    signIn.searchParams.set('next', pathname);
    return NextResponse.redirect(signIn);
  }

  if (user && pathname.startsWith('/sign-in')) {
    const home = request.nextUrl.clone();
    home.pathname = '/';
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
