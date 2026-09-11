import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { DoorScreen } from '@/components/door-screen';
import { FindShop } from '@/components/find-shop';
import { OwnerPinPad } from '@/components/owner-pin-pad';
import { OwnerTotpPrompt } from '@/components/owner-totp-prompt';
import { currentAuth, ownerMfaState } from '@/lib/auth';
import { ownerDestination } from '@/lib/destinations';
import { currentSurface } from '@/lib/supabase';

export const metadata: Metadata = {
  title: { absolute: 'Carl Owner' },
  robots: { index: false, follow: false },
};
export const dynamic = 'force-dynamic';

/**
 * The main address: the platform owner's way in.
 *
 * `/` used to be a marketing page, and the owner's PIN lived at /platform/sign-in behind an
 * "install first" gate. Opening Carl's address showed the owner a sales pitch, and an app
 * installed from it opened the same sales pitch. The main address is now the owner's entry,
 * and a correct PIN leads to the console and nowhere else.
 *
 * On a deployment where the console has its own hostname, this address belongs to the
 * businesses instead, and answers with the till finder rather than the owner's PIN. Which one
 * it is comes from the proxy, never from the request itself.
 *
 * ## What it is not
 *
 * Not an installable application. No manifest is declared here or inherited, so a browser
 * offers nothing to install on this page. The installed Carl app is the POS, installed from a
 * business's own POS address; the owner console stays here, in the browser.
 *
 * Two steps, when the owner has an authenticator app: the PIN, then the code. The second step
 * happens here rather than on a page of its own, so a session that has the PIN and not the code
 * has nowhere else to be — every console screen sends it back here.
 *
 * Not a door to any business. It reads only the owner console's own session (lib/surface.ts),
 * so a cashier or shop administrator signed in on this device is invisible here, and no
 * business PIN opens it: `verify_platform_pin` accepts only a platform administrator's.
 */
export default async function OwnerEntryPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  // The shops' hostname, where this address is theirs and the console lives elsewhere.
  if ((await currentSurface()) === 'business') {
    return (
      <DoorScreen
        footer="Ask your manager for the address if you do not have it."
        picture="shopfront"
      >
        <header className="mb-8 text-center">
          <div className="text-2xl font-semibold tracking-tight">Carl</div>
          <p className="mt-6 text-sm text-[color:var(--color-ink-muted)]">
            Enter the address your business was given
          </p>
        </header>
        <FindShop />
      </DoorScreen>
    );
  }

  const auth = await currentAuth();
  const mfa = auth?.user.isPlatformAdmin ? await ownerMfaState() : null;
  const awaitingCode = mfa !== null && mfa.required && !mfa.satisfied;
  if (auth?.user.isPlatformAdmin && !awaitingCode) redirect(ownerDestination(next));

  return (
    <DoorScreen footer="Working at a shop? Open the address your business was given.">
      <header className="mb-10 text-center">
        <div className="text-2xl font-semibold tracking-tight">Carl</div>
        <h1 className="mt-6 text-lg font-medium">Owner console</h1>
        <p className="mt-1.5 text-sm text-[color:var(--color-ink-muted)]">
          {awaitingCode
            ? 'Enter the 6-digit code from your authenticator app'
            : 'Enter your 4-digit PIN to continue'}
        </p>
      </header>
      {awaitingCode ? <OwnerTotpPrompt next={next} /> : <OwnerPinPad next={next} />}
    </DoorScreen>
  );
}
