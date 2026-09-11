import type { Metadata } from 'next';

import { FindShop } from '@/components/find-shop';

export const metadata: Metadata = {
  title: { absolute: 'Open your till · Carl' },
  robots: { index: false, follow: false },
};

/**
 * Where a till app lands when the device has not signed in to a business yet.
 *
 * Reached from the proxy, when a till screen is asked for with no session and nothing
 * remembered about which business this device belongs to.
 */
export default function FindShopPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <header className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Open your till</h1>
          <p className="mt-1.5 text-sm text-[color:var(--color-ink-muted)]">
            Enter the address your business was given
          </p>
        </header>
        <FindShop />
      </div>
    </main>
  );
}
