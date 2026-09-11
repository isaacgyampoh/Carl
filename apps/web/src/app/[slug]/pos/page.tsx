import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { InstallGate } from '@/components/install-gate';
import { currentAuth } from '@/lib/auth';
import { memberTenantAtSlug } from '@carl/infrastructure/auth/resolve-auth-context';
import { supabase } from '@/lib/supabase';
import { MemberPinPad } from '../member-pin-pad';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: { absolute: 'Carl POS' },
    applicationName: 'Carl POS',
    robots: { index: false, follow: false },
    // Page metadata, never a raw <link>: exactly one manifest, and it is the till app's.
    manifest: `/${slug}/manifest.webmanifest`,
    // iOS takes a home-screen app's name and standalone mode from these, not the manifest.
    appleWebApp: { capable: true, title: 'Carl POS', statusBarStyle: 'default' },
  };
}
export const dynamic = 'force-dynamic';

/**
 * A business's till: where the installed Carl POS app starts.
 *
 * The POS app's `start_url`. Launched, it opens here; a person already signed in to this
 * business goes straight to the till, and anyone else types their PIN and then goes to the
 * till. Always the till — including for the business's administrator, whose portal is at the
 * business's own address — and never the owner console, which has no door from here at all.
 *
 * It renders identically for every slug, like the business's own address, so it cannot be
 * used to find out which businesses are on Carl.
 */
export default async function PosEntryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const auth = await currentAuth();

  if (auth) {
    // Filtered by the caller's own user id, as at the business's address: reading a
    // membership is not belonging to the business.
    const client = await supabase();
    const membership = await memberTenantAtSlug(client, auth.user.userId, slug);
    if (membership) redirect(`/${slug}/enter?to=pos`);
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <InstallGate
          title="Install Carl POS"
          description="The till app for this business. Installed, it opens straight to this business's POS in its own window. The business portal and the owner console stay in the browser."
        >
          <header className="mb-10 text-center">
            <h1 className="text-2xl font-semibold tracking-tight">Carl POS</h1>
            <p className="mt-1 text-sm text-[color:var(--color-ink-muted)]">
              Enter your 4-digit PIN to open the till
            </p>
          </header>
          <MemberPinPad slug={slug} entry="pos" />
        </InstallGate>
      </div>
    </main>
  );
}
