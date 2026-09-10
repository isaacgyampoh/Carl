import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

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
      "img-src 'self' data: blob:",
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
