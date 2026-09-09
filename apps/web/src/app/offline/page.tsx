import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Offline' };

/**
 * Shown by the service worker when a page cannot be fetched.
 *
 * Deliberately honest. The browser build cannot take a sale offline, and implying
 * otherwise would leave a cashier believing a transaction was recorded when it was not.
 * Offline selling is what the desktop application is for.
 */
export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight">No connection</h1>
        <p className="mt-2 text-sm text-[color:var(--color-ink-muted)]">
          Carl cannot reach the server. Nothing has been lost — anything already saved is on the
          server, and this page will work again as soon as the connection returns.
        </p>
        <p className="mt-4 text-sm text-[color:var(--color-ink-muted)]">
          To keep selling through an outage, use <strong>Carl Desktop</strong>, which records sales
          locally and synchronises them when the connection comes back.
        </p>
      </div>
    </main>
  );
}
