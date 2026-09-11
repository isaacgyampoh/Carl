import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { currentAuth } from '@/lib/auth';
import { InstallGate } from '@/components/install-gate';
import { PinPad } from './pin-pad';

export const metadata: Metadata = {
  title: 'Carl Owner',
  robots: { index: false, follow: false },
  /*
   * This page is outside the `(app)` group, where `platform.webmanifest` is declared, so it
   * inherited the root layout's generic manifest. Installing from the owner's own entry page
   * therefore produced the shop-facing application starting at the marketing page, not the
   * owner console.
   */
  manifest: '/platform.webmanifest',
};
export const dynamic = 'force-dynamic';

/**
 * The owner's way in.
 *
 * Outside the `(app)` group on purpose: that layout renders a shopkeeper's navigation, and
 * none of it belongs around a PIN prompt for the person who runs Carl itself.
 */
export default async function PlatformSignInPage() {
  const auth = await currentAuth();
  if (auth?.user.isPlatformAdmin) redirect('/platform');

  return (
    <main className="flex min-h-dvh flex-col px-6">
      <div className="flex flex-1 flex-col items-center justify-center">
        <div className="w-full max-w-sm">
          {/* The owner console is reached through its installed application, not a browser tab:
              installation comes first, and disappears once the app is running standalone. */}
          <InstallGate
            title="Install Carl Owner"
            description="The owner console runs as its own application on this computer or phone. Installed, it opens in its own window, separate from any shop's till."
          >
            <header className="mb-12 text-center">
              <div className="text-2xl font-semibold tracking-tight">Carl</div>
              <h1 className="mt-8 text-lg font-medium">Owner</h1>
              <p className="mt-1.5 text-sm text-[color:var(--color-ink-muted)]">
                Enter your 4-digit PIN to continue
              </p>
            </header>
            <PinPad />
          </InstallGate>
        </div>
      </div>
      <footer className="pb-8 text-center text-xs text-[color:var(--color-ink-muted)]">Carl</footer>
    </main>
  );
}
