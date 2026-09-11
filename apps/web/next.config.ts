import { networkInterfaces } from 'node:os';
import type { NextConfig } from 'next';

/**
 * This machine's own addresses on the local network, so `next dev` can be used from a phone
 * or another computer on the same Wi-Fi.
 *
 * Next.js refuses dev-only assets (the page's scripts, hot reload) to any origin other than
 * the host the dev server started on. Opened from a phone at http://192.168.x.y:3000, the HTML
 * arrived but its scripts were refused, so the page drew and never became interactive: no
 * button worked, no form submitted.
 *
 * Only this machine's private IPv4 addresses, read when the dev server starts (joining a
 * different network needs a restart), and Bonjour names (*.local). Nothing public, and
 * production builds ignore the option entirely.
 */
function localNetworkOrigins(): string[] {
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address)
    .filter((address) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address));
  return [...new Set(addresses), '*.local'];
}

const nextConfig: NextConfig = {
  reactStrictMode: true,

  allowedDevOrigins: localNetworkOrigins(),

  experimental: {
    serverActions: {
      // A product image may be up to 2 MB. Server actions cap requests at 1 MB by default,
      // which refused an ordinary photo before it reached the size check.
      bodySizeLimit: '3mb',
    },
  },

  // Workspace packages ship as TypeScript source; Next compiles them in-place.
  transpilePackages: [
    '@carl/application',
    '@carl/database',
    '@carl/domain',
    '@carl/infrastructure',
    '@carl/shared',
    '@carl/types',
    '@carl/ui',
    '@carl/validation',
  ],

  typescript: {
    // A broken build must fail here rather than ship. `pnpm typecheck` is the fast gate.
    ignoreBuildErrors: false,
  },
  // Linting runs as its own CI job (`pnpm lint`), so it is not repeated during the build.
  // Carl handles money and stock. Nothing here should be embedded in a page cache by accident.
  poweredByHeader: false,

  async headers() {
    /*
     * Two policies ship, and the split is the point.
     *
     * ## The enforcing policy
     *
     * A Report-Only policy blocks nothing. Carl's back office moves money and stock, so
     * shipping *only* a report-only header means the highest-impact injection vectors stay
     * open indefinitely while everyone waits for the reports to look clean.
     *
     * The directives below are enforced because breaking them requires the application to
     * do something it verifiably does not do:
     *
     *   object-src 'none'      — no <object> or <embed> anywhere. A long-standing CSP
     *                            bypass vector, and free to close.
     *   base-uri 'self'        — an injected <base> rewrites every relative URL on the
     *                            page, including the ones the sign-in form posts to.
     *                            Nothing renders a <base>.
     *   form-action 'self'     — stops an injected form from posting a cashier's input to
     *                            somebody else's host. Every form here is a React Server
     *                            Action, which is same-origin by construction.
     *   frame-ancestors 'none' — clickjacking. Already asserted by X-Frame-Options; this
     *                            is the modern spelling, and the one browsers still honour.
     *
     * There is deliberately no `default-src` here: an enforcing policy restricts only the
     * directives it names, and naming more than can be verified is how a till stops working
     * in a shop.
     *
     * ## The report-only policy
     *
     * `script-src` is the one that cannot be enforced yet. Next.js serves inline bootstrap
     * scripts, so enforcing needs either a nonce threaded through every response or
     * `'unsafe-inline'` — and `'unsafe-inline'` gives away most of what script-src is for.
     * That policy stays Report-Only, with somewhere to report, until the evidence says a
     * strict one would not break the application.
     *
     * So the checklist entry is PARTIAL, honestly: script execution is measured, not
     * controlled. It is no longer "nothing is enforced".
     *
     * The desktop application does have a fully enforcing CSP: its WebView serves a static
     * bundle with no inline scripts, so it can.
     */
    const enforcedCsp = [
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      'report-uri /api/csp-report',
    ].join('; ');

    const reportOnlyCsp = [
      "default-src 'self'",
      // 'unsafe-inline' is present because Next's bootstrap needs it. Removing it is the
      // work that has to happen before this policy can be enforced.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      // Product images are served from private Storage through short-lived signed URLs.
      "img-src 'self' data: blob: https://*.supabase.co",
      "font-src 'self' data:",
      // The only origins Carl talks to.
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      // Without this the policy is only a warning in somebody's console. Violations are
      // collected so enforcement can be an evidence-based decision rather than a hopeful
      // one — see /api/csp-report.
      'report-uri /api/csp-report',
    ].join('; ');

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
          /*
           * A shop's staff sign in over public wifi and mobile networks. Without HSTS, the
           * first request of the day is plaintext and downgradable; with it, the browser
           * refuses to speak HTTP to this origin at all.
           *
           * Two years, with subdomains. `preload` is deliberately omitted: getting onto the
           * preload list is easy and getting off it takes months, which is not a commitment
           * to make on Carl's behalf before a custom domain is settled.
           */
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains',
          },
          { key: 'Content-Security-Policy', value: enforcedCsp },
          { key: 'Content-Security-Policy-Report-Only', value: reportOnlyCsp },
        ],
      },
    ];
  },
};

export default nextConfig;
