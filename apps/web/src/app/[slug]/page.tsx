import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { currentAuth } from '@/lib/auth';
import { memberTenantAtSlug } from '@carl/infrastructure/auth/resolve-auth-context';
import { supabase } from '@/lib/supabase';
import { DoorScreen } from '@/components/door-screen';
import { MemberPinPad } from './member-pin-pad';

/*
 * The manifest is set here, as page metadata, and not as a raw <link> in the body.
 *
 * A raw link in the page body once ADDED a second manifest after an inherited one, and browsers
 * use the first: an installed shop application opened on the marketing page. Page metadata
 * emits exactly one.
 *
 * It is the business's POS app manifest (start_url `/{slug}/pos`). Declared here too, rather
 * than only on the till's door, so an app installed from this address before the till had its
 * own door picks up the new start_url the next time it opens here.
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
 * A business's own address: the way into its portal.
 *
 * Staff type their PIN here and go, by their own grants, to the dashboard or to the till. It is
 * not the installed app's door — that is `/{slug}/pos` — so there is no install gate in front
 * of the PIN: installing is offered where the till is, under its own name.
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

    // In through /enter, which selects this business and decides from the person's own grants
    // whether that means the dashboard or the till.
    if (membership) redirect(`/${slug}/enter`);
    // Not a member here — including the platform owner — so this business's own sign-in.
  }

  return (
    <DoorScreen
      footer={
        <>
          Setting up a till?{' '}
          <Link
            href={`/${slug}/pos`}
            className="font-medium text-[color:var(--color-ink)] underline-offset-4 hover:underline"
          >
            Open Carl POS
          </Link>
        </>
      }
    >
      <header className="mb-10 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to Carl</h1>
        <p className="mt-1.5 text-sm text-[color:var(--color-ink-muted)]">Enter your 4-digit PIN</p>
      </header>
      <MemberPinPad slug={slug} entry="portal" />
    </DoorScreen>
  );
}
