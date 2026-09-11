import { NextResponse } from 'next/server';

/**
 * A web app manifest per business.
 *
 * ## Why this is not the one manifest in `public/`
 *
 * That manifest has `start_url: "/"`. A shop that installed Carl from their own address got
 * an application that opened on the public marketing page — the sales pitch for software
 * they had just bought — and had to navigate back to their till every morning. `scope` was
 * the whole site too, so the installed window was not anchored to their business at all.
 *
 * Each business therefore gets its own manifest, with `start_url` and `scope` at their
 * address and a distinct `id`, so Windows and Android treat two shops as two applications
 * rather than reinstalling over each other.
 *
 * ## Why it does not look the business up
 *
 * `/[slug]` renders identically for every slug on purpose: checking would tell anyone who
 * asked which businesses are on Carl, which is a competitor's customer list obtainable with
 * a script. This keeps that property — it reads nothing from the database, so an unknown
 * slug is indistinguishable from a real one here too.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;

  // Bounded and sanitised: this value is echoed into a document that a browser installs as
  // an application. Anything outside the slug alphabet is not a slug Carl ever issued.
  const safe = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(slug) ? slug : '';
  if (!safe) return new NextResponse('Not found', { status: 404 });

  return NextResponse.json(
    {
      id: `/${safe}`,
      name: `Carl · ${safe}`,
      short_name: 'Carl',
      description: 'Point of sale, inventory and business management.',
      start_url: `/${safe}`,
      scope: `/${safe}`,
      display: 'standalone',
      orientation: 'any',
      background_color: '#ffffff',
      theme_color: '#ffffff',
      categories: ['business', 'productivity', 'finance'],
      // PNGs first: iOS ignores SVG home-screen icons, and Android builds its installed app
      // from raster sizes. The SVG stays for browsers that prefer it.
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        {
          src: '/icons/icon-maskable-192.png',
          sizes: '192x192',
          type: 'image/png',
          purpose: 'maskable',
        },
        {
          src: '/icons/icon-maskable-512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        },
        { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      ],
    },
    {
      headers: {
        'content-type': 'application/manifest+json',
        // A shop's manifest is not secret, but it is theirs; it should not sit in a shared
        // cache keyed only by path.
        'cache-control': 'public, max-age=3600',
      },
    },
  );
}
