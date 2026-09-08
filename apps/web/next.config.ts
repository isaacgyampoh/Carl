import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Workspace packages ship as TypeScript source; Next compiles them in-place.
  transpilePackages: [
    '@carl/application',
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
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
