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
     * The Content Security Policy is REPORT-ONLY, deliberately.
     *
     * Next.js serves inline bootstrap scripts, so an enforcing policy needs either a nonce
     * threaded through every response or `'unsafe-inline'`, which gives most of the
     * protection away. Shipping a strict policy without measuring it first would break the
     * till in production — the one place a shop cannot work around it — so this collects
     * violations first and is promoted to enforcing once the reports are clean.
     *
     * It is recorded as PARTIAL in the production checklist rather than as a control that
     * is in place, because a Report-Only policy blocks nothing.
     *
     * The desktop application does have an enforcing CSP: its WebView serves a static
     * bundle with no inline scripts, so it can.
     */
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
          { key: 'Content-Security-Policy-Report-Only', value: reportOnlyCsp },
        ],
      },
    ];
  },
};

export default nextConfig;
