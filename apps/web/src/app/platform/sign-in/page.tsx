import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { currentAuth } from '@/lib/auth';
import { PinPad } from './pin-pad';

export const metadata: Metadata = {
  title: 'Carl Owner',
  // The owner console is not something to index or preview.
  robots: { index: false, follow: false },
};
export const dynamic = 'force-dynamic';

/**
 * The owner's way in.
 *
 * Deliberately outside the `(app)` group: that layout renders the merchant shell —
 * navigation to tills, stock and customers — and none of it belongs around a PIN prompt
 * for a person who does not own a shop.
 */
export default async function PlatformSignInPage() {
  const auth = await currentAuth();
  if (auth?.user.isPlatformAdmin) redirect('/platform');

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <header className="mb-10 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Carl Owner</h1>
          <p className="mt-1 text-sm text-[color:var(--color-text-muted)]">
            Enter your PIN to continue
          </p>
        </header>
        <PinPad />
      </div>
    </main>
  );
}
