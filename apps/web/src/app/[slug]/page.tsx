import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { currentAuth } from '@/lib/auth';
import { memberTenantAtSlug } from '@carl/infrastructure/auth/resolve-auth-context';
import { supabase } from '@/lib/supabase';
import { MemberPinPad } from './member-pin-pad';
import { InstallGate } from '@/components/install-gate';

/*
 * The manifest is set here, as page metadata, and not as a raw <link> in the body.
 *
 * The root layout declares `/manifest.webmanifest`. A raw link in the page ADDED a second
 * manifest after it, and browsers use the first: live, a shop's page carried the generic
 * manifest ahead of its own, so an installed shop application still opened on the marketing
 * page. Page metadata overrides the layout's field, so exactly one manifest is emitted.
 *
 * Reads only the slug from the URL, never the database — see the page comment below.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: 'Carl',
    robots: { index: false, follow: false },
    manifest: `/${slug}/manifest.webmanifest`,
  };
}
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
  /*
   * Only a member of THIS business is taken inside.
   *
   * This used to send every signed-in session to /platform or /dashboard regardless of the
   * address: the platform owner opening a client's URL landed in the owner console, and a
   * member of one shop opening another shop's URL landed in their own. All businesses share
   * one origin and therefore one session cookie, so the address has to be checked against
   * the session, not assumed.
   *
   * The check is filtered by the caller's own user id, not left to RLS. The platform owner
   * can READ every business's memberships, so an unfiltered "is there an active membership
   * at this slug?" found the business administrator's row and let the owner in. That was
   * how a client's address opened the owner console. Filtered, it also reveals nothing
   * about whether a business exists to anyone who does not belong to it.
   */
  if (auth) {
    const client = await supabase();
    const membership = await memberTenantAtSlug(client, auth.user.userId, slug);

    if (membership) {
      // Already operating in this business: straight in. Otherwise switch to it first.
      redirect(auth.tenant?.tenantId === membership.tenantId ? '/dashboard' : `/${slug}/enter`);
    }
    // Not a member here — including the platform owner — so this business's own sign-in.
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <InstallGate>
          <header className="mb-10 text-center">
            <h1 className="text-2xl font-semibold tracking-tight">Welcome to Carl</h1>
            <p className="mt-1 text-sm text-[color:var(--color-ink-muted)]">
              Enter your 4-digit PIN
            </p>
          </header>
          <MemberPinPad slug={slug} />
        </InstallGate>
      </div>
    </main>
  );
}
