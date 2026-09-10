'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Alert, buttonClasses } from '@carl/ui';

import type { DownloadTarget } from '@/lib/downloads';

/**
 * What the owner gives the customer.
 *
 * The moment after onboarding is the one where the owner is sitting with the merchant and
 * needs three things to hand over: where to sign in, how to get the desktop till, and what
 * happens next. Anything else here is noise at exactly the wrong moment.
 */
export function ClientHandover({
  businessName,
  tenantId,
  branchName,
  status,
  nextBillingAt,
  ownerEmail,
  appUrl,
  slug,
  initialPin,
  downloads,
}: {
  businessName: string;
  tenantId: string;
  branchName: string;
  status: string;
  nextBillingAt: string;
  ownerEmail: string;
  appUrl: string;
  slug: string;
  initialPin: string | null;
  downloads: DownloadTarget[];
}) {
  const shopUrl = `${appUrl.replace(/\/$/, '')}/${slug}`;
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard access can be refused — an insecure context, or a permission prompt the
      // owner dismissed. The value is on screen and selectable either way.
      setCopied(null);
    }
  }

  return (
    <div className="space-y-6 p-4">
      <Alert tone="positive" title={`${businessName} is set up`}>
        The business, its first branch, the owner&apos;s login and the subscription were created
        together.
      </Alert>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Their Carl address</h3>
        <div className="flex items-stretch gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface-muted)] px-3 py-3 text-sm">
            {shopUrl}
          </code>
          <button
            type="button"
            onClick={() => void copy('url', shopUrl)}
            className={buttonClasses({ variant: 'secondary' })}
          >
            {copied === 'url' ? 'Copied' : 'Copy'}
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Their PIN</h3>
        {initialPin ? (
          <>
            <div className="flex items-stretch gap-2">
              <code className="flex-1 rounded-lg border border-[color:var(--color-brand)] bg-[color:var(--color-surface)] px-3 py-3 text-center text-2xl tracking-[0.5em]">
                {initialPin}
              </code>
              <button
                type="button"
                onClick={() => void copy('pin', initialPin)}
                className={buttonClasses({ variant: 'secondary' })}
              >
                {copied === 'pin' ? 'Copied' : 'Copy'}
              </button>
            </div>
            {/* Said plainly, because it is true and it is the one thing the owner must not
                assume they can look up later. */}
            <p className="text-sm text-[color:var(--color-text-muted)]">
              Shown once. Carl stores it hashed, so it cannot be read back — write it down or read
              it to {ownerEmail} now. Carl will ask them to choose their own the first time they
              sign in.
            </p>
          </>
        ) : (
          <p className="text-sm text-[color:var(--color-danger)]">
            The starting PIN could not be issued. Open the client below and issue one from their
            page — the business itself was created correctly.
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Desktop till</h3>
        <ul className="space-y-2">
          {downloads.map((d) => (
            <li
              key={d.platform}
              className="flex items-center justify-between gap-3 rounded-lg border border-[color:var(--color-border)] px-3 py-3"
            >
              <span className="min-w-0">
                <span className="block font-medium">Carl for {d.platform}</span>
                <span className="block truncate text-sm text-[color:var(--color-text-muted)]">
                  {d.note}
                </span>
              </span>
              {d.url ? (
                <a href={d.url} className={buttonClasses({ variant: 'secondary' })}>
                  Download
                </a>
              ) : (
                <span className="shrink-0 rounded-full bg-[color:var(--color-surface-muted)] px-3 py-1 text-sm text-[color:var(--color-text-muted)]">
                  Not yet available
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="text-sm text-[color:var(--color-text-muted)]">
          The web application works in any browser meanwhile, including on a phone. The desktop till
          is what keeps selling when the internet does not.
        </p>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Setting up their terminal</h3>
        <p className="text-sm text-[color:var(--color-text-muted)]">
          Open {businessName} below, add a terminal for {branchName}, and issue an activation code.
          The code is shown once — read it to them, and they enter it on the till.
        </p>
      </section>

      <dl className="grid gap-3 border-t border-[color:var(--color-border)] pt-4 sm:grid-cols-3">
        {[
          ['Status', status.replace('_', ' ')],
          ['First branch', branchName],
          ['Next billing', new Date(nextBillingAt).toLocaleDateString('en-GB')],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-sm text-[color:var(--color-text-muted)]">{label}</dt>
            <dd className="font-medium">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-wrap gap-2">
        <Link
          href={`/platform/clients/${tenantId}`}
          className={buttonClasses({ variant: 'primary' })}
        >
          Open {businessName}
        </Link>
        <Link href="/platform/onboarding" className={buttonClasses({ variant: 'secondary' })}>
          Add another client
        </Link>
      </div>
    </div>
  );
}
