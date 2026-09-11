import { NextResponse } from 'next/server';

/**
 * The Carl POS app, per business.
 *
 * ## What is installed
 *
 * The till. `start_url` is the business's POS door, `/{slug}/pos`, which leads a signed-in
 * cashier straight to the till and anyone else to a PIN and then the till. It used to be the
 * business's address, and before that `/` — so an installed app opened on the business portal,
 * or on the public website, rather than on the POS it was installed to be.
 *
 * Named "Carl POS" so nobody mistakes it for the owner console, which is not installable and is
 * used in the browser at the main address.
 *
 * ## Identity
 *
 * `id` is `/{slug}`, unchanged since the first per-business manifest, so an app already
 * installed updates in place to the new start_url instead of becoming a second app. Two
 * businesses are two applications, never one reinstalling over the other.
 *
 * `scope` is the whole origin, deliberately. The till's own screens (/pos, /register, /sales)
 * are shared routes, not under /{slug}; scoped narrower, every screen after the PIN was outside
 * the app and showed a browser bar over the till. Which business a request operates in is
 * decided by the server, never by scope.
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
      name: `Carl POS · ${safe}`,
      short_name: 'Carl POS',
      description: 'The Carl till for this business: sell, take payment and print receipts.',
      start_url: `/${safe}/pos`,
      scope: '/',
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
        // Revalidated on every fetch: an hour-old copy is how an installed app keeps an old
        // start_url after it has changed.
        'cache-control': 'no-cache',
      },
    },
  );
}
