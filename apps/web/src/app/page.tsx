import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { currentAuth } from '@/lib/auth';

export const metadata: Metadata = {
  title: 'Carl — point of sale for Ghanaian retail',
  description:
    'Sell, track stock and see what your shop is making. Works on a phone, and keeps selling when the internet does not.',
};
export const dynamic = 'force-dynamic';

/**
 * The public face of Carl.
 *
 * Deliberately outside the `(app)` group: that layout renders a shopkeeper's navigation —
 * tills, stock, suppliers — and none of it means anything to somebody who has not signed
 * in yet.
 *
 * A signed-in shopkeeper who lands here is sent to their dashboard rather than shown a
 * sales pitch for software they already use.
 */
export default async function HomePage() {
  const auth = await currentAuth();
  if (auth) redirect(auth.user.isPlatformAdmin ? '/platform' : '/dashboard');

  return (
    <main className="mx-auto max-w-5xl px-6 py-16 sm:py-24">
      {/* No sign-in link anywhere on this page, deliberately.
          This is the public marketing site. Carl's own administration console can onboard,
          suspend and bill every customer on the platform, and advertising its entrance to
          every visitor gains a shopkeeper nothing while handing an attacker the door to
          knock on. Shops reach Carl through the address their business was given; the
          platform owner reaches it through the installed application. */}
      <header className="flex items-center justify-between">
        <span className="text-lg font-semibold tracking-tight">Carl</span>
      </header>

      <section className="mt-16 max-w-2xl sm:mt-24">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Run your shop, not your software.
        </h1>
        <p className="mt-5 text-lg text-[color:var(--color-text-muted)]">
          Carl is a point of sale and stock system for shops with one counter or twenty. It keeps
          selling when the internet drops, and tells you what you actually made at the end of the
          day.
        </p>
        <p className="mt-6 text-sm text-[color:var(--color-text-muted)]">
          Already using Carl? Open the link your provider gave you.
        </p>
      </section>

      <section className="mt-20 grid gap-x-10 gap-y-10 sm:mt-28 sm:grid-cols-2">
        {[
          {
            title: 'Sell in seconds',
            body: 'Scan or search, take cash, mobile money, card or a mix of them, and print a receipt. Prices and discounts are decided by the server, never by the till.',
          },
          {
            title: 'Keeps working offline',
            body: 'The desktop till holds its own copy of your catalogue and records every sale locally. When the connection returns, the sales sync themselves — exactly once.',
          },
          {
            title: 'Stock that adds up',
            body: 'Every movement is written to a ledger that cannot be edited after the fact. Purchases, transfers between branches, counts and adjustments all reconcile.',
          },
          {
            title: 'Knows who did what',
            body: 'Each person signs in with their own four-digit PIN, so a sale, a refund and a discount all carry a name. Managers approve what cashiers cannot.',
          },
          {
            title: 'More than one branch',
            body: 'Move stock between shops, see each branch separately or together, and give staff access only to where they work.',
          },
          {
            title: 'On the phone in your pocket',
            body: 'Install Carl from the browser and it behaves like an app. No app store, no waiting for approval, no separate download to keep updated.',
          },
        ].map((feature) => (
          <div key={feature.title}>
            <h2 className="font-medium">{feature.title}</h2>
            <p className="mt-2 text-sm text-[color:var(--color-text-muted)]">{feature.body}</p>
          </div>
        ))}
      </section>

      <section className="mt-20 border-t border-[color:var(--color-border)] pt-10 sm:mt-28">
        <h2 className="text-xl font-medium">Getting started</h2>
        <ol className="mt-4 space-y-3 text-sm text-[color:var(--color-text-muted)]">
          <li>
            <span className="font-medium text-[color:var(--color-text)]">1.</span> Your Carl
            provider sets up your business and gives you a link and a four-digit PIN.
          </li>
          <li>
            <span className="font-medium text-[color:var(--color-text)]">2.</span> Open the link,
            enter the PIN, and choose your own.
          </li>
          <li>
            <span className="font-medium text-[color:var(--color-text)]">3.</span> Install Carl on
            the counter machine to sell offline, or use it straight from a phone.
          </li>
        </ol>
      </section>

      <footer className="mt-20 flex flex-wrap items-center justify-between gap-4 border-t border-[color:var(--color-border)] pt-8 text-sm text-[color:var(--color-text-muted)] sm:mt-28">
        <span>Carl</span>
        <span>Already a customer? Open the address your business was given.</span>
      </footer>
    </main>
  );
}
