/*
 * Carl's service worker.
 *
 * ## What this does, and deliberately does not do
 *
 * It caches the application shell and static assets so Carl loads instantly and opens at
 * all on a dropped connection. That is the whole of its job.
 *
 * It does **not** cache API responses or attempt to queue writes. Two reasons:
 *
 *   1. A cached price or stock level is a *wrong* price or stock level. Showing a cashier
 *      yesterday's catalogue as though it were current is worse than showing nothing.
 *   2. Browser storage is not where a financial transaction belongs. Offline selling is
 *      the desktop application's job, backed by SQLite and a real sync engine
 *      (see docs/OFFLINE_SYNC.md). A service worker that half-implemented it would be a
 *      second, weaker copy of that logic — and the weak copy is the one handling money.
 *
 * So the PWA gives offline *awareness*: the app opens, says plainly that it is offline,
 * and does not pretend it can take a sale.
 */

const VERSION = 'carl-v1';
const SHELL_CACHE = `${VERSION}-shell`;

/** Assets worth having before they are asked for. */
const PRECACHE = ['/offline', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // `reload` so an install never picks up a stale copy from the HTTP cache.
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))))
      // Activate immediately rather than waiting for every tab to close. A till is often
      // left open for days, and an update that never takes effect is not an update.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only GET is ever served from cache. Replaying a POST from a cache would mean replaying
  // a sale.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache anything that touches data or authentication. A stale answer here is not a
  // slightly-old page — it is a wrong price, or someone else's session.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname.startsWith('/rest/') ||
    url.pathname.startsWith('/sign-in')
  ) {
    return;
  }

  // Immutable build output: cache first, because the filename changes when the content does.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            const copy = response.clone();
            void caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
            return response;
          }),
      ),
    );
    return;
  }

  // Pages: network first, falling back to the offline page. Never serve a stale page as
  // though it were live — a shop looking at yesterday's stock figures is worse off than a
  // shop being told it is offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches
          .match('/offline')
          .then((cached) => cached ?? new Response('Offline', { status: 503 })),
      ),
    );
  }
});
