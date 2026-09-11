import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { currentAuth } from '@/lib/auth';
import { MemberPinPad } from './member-pin-pad';
import { InstallGate } from './install-gate';

export const metadata: Metadata = {
  title: 'Carl',
  robots: { index: false, follow: false },
};
export const dynamic = 'force-dynamic';

/**
 * A shop's front door.
 *
 * ## Why this does not check whether the business exists
 *
 * It would be easy to 404 an unknown slug, and it would tell anybody who asked which
 * businesses are on Carl — a list of a competitor's customers, obtainable with a script.
 * So every slug renders the same page, and `verify_member_pin` gives the same answer for a
 * wrong PIN and a business that does not exist.
 *
 * The cost is that a typo looks like a real shop with a PIN that never works. That is a
 * small price for not publishing a customer list.
 */
export default async function ShopEntryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const auth = await currentAuth();
  // Already signed in: no reason to ask again.
  if (auth) redirect(auth.user.isPlatformAdmin ? '/platform' : '/dashboard');

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 py-12">
      {/* This business's own manifest, so installing from here produces an application that
          opens on their till rather than on Carl's marketing page. */}
      <link rel="manifest" href={`/${slug}/manifest.webmanifest`} />
      <div className="w-full max-w-sm">
        <InstallGate>
          <header className="mb-10 text-center">
            <h1 className="text-2xl font-semibold tracking-tight">Welcome to Carl</h1>
            <p className="mt-1 text-sm text-[color:var(--color-text-muted)]">
              Enter your 4-digit PIN
            </p>
          </header>
          <MemberPinPad slug={slug} />
        </InstallGate>
      </div>
    </main>
  );
}
