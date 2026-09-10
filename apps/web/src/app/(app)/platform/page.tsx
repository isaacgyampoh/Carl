import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, CardHeader, EmptyState, Stat, buttonClasses, statusTone } from '@carl/ui';
import { Currency, formatMoney } from '@carl/shared';

import { PageHeader } from '@/components/page-header';
import { billingState, daysUntil, platformOverview } from '@/server/platform-queries';

export const metadata: Metadata = { title: 'Carl platform' };
export const dynamic = 'force-dynamic';

/**
 * The platform owner's console.
 *
 * Built to answer the questions that decide a working day: who owes money, who is about
 * to, and who is new. Everything else is a click away.
 *
 * Note what is *not* here: any customer's sales, stock or takings. Being a platform
 * administrator grants the platform — clients, devices, subscriptions, billing — and
 * nothing about a business's own trade. Reading that needs an explicit, time-boxed
 * support grant the customer can see.
 */
export default async function PlatformPage() {
  const { overview, recent } = await platformOverview();
  // The console shows one platform-wide currency. Carl's tenants are Ghanaian today, and
  // a mixed-currency total would be a wrong number rather than a useful one.
  const currency = (overview.currencyCode as Currency) ?? Currency.GHS;
  const money = (minor: number) => formatMoney(minor, currency);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Platform"
        description="Carl's customers, their subscriptions and their terminals."
        action={
          <Link href="/platform/onboarding" className={buttonClasses({ variant: 'primary' })}>
            Add client
          </Link>
        }
      />

      {/* The money questions first, because they are the ones with a deadline. */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Clients" value={overview.total.toLocaleString('en-GH')} />
        <Stat label="Active" value={overview.active.toLocaleString('en-GH')} tone="positive" />
        <Stat label="Trial" value={overview.trial.toLocaleString('en-GH')} />
        <Stat
          label="Due soon"
          value={overview.dueSoon.toLocaleString('en-GH')}
          tone={overview.dueSoon > 0 ? 'warning' : 'neutral'}
        />
        <Stat
          label="Overdue"
          value={overview.overdue.toLocaleString('en-GH')}
          tone={overview.overdue > 0 ? 'danger' : 'neutral'}
        />
        <Stat
          label="Suspended"
          value={overview.suspended.toLocaleString('en-GH')}
          tone={overview.suspended > 0 ? 'danger' : 'neutral'}
        />
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <Stat label="Expected this month" value={money(overview.expectedThisMonth)} />
        <Stat label="Branches" value={overview.branches.toLocaleString('en-GH')} />
        <Stat
          label="Terminals active"
          value={overview.activeDevices.toLocaleString('en-GH')}
          {...(overview.pendingActivations > 0
            ? { hint: `${overview.pendingActivations} awaiting activation` }
            : {})}
        />
      </section>

      <nav className="flex flex-wrap gap-2">
        {(
          [
            ['Clients', '/platform/clients'],
            ['Billing', '/platform/billing'],
            ['Invoices', '/platform/invoices'],
            ['Terminals', '/platform/devices'],
            ['Activity', '/platform/audit'],
          ] as const
        ).map(([label, href]) => (
          <Link key={href} href={href} className={buttonClasses({ variant: 'secondary' })}>
            {label}
          </Link>
        ))}
      </nav>

      <Card>
        <CardHeader
          title="Recently onboarded"
          action={
            <Link href="/platform/clients" className="text-sm underline underline-offset-4">
              All clients
            </Link>
          }
        />
        {recent.length === 0 ? (
          <EmptyState
            title="No clients yet"
            description="Onboard the first business to start using Carl."
          />
        ) : (
          <ul className="divide-y divide-[color:var(--color-border)]">
            {recent.map((c) => {
              const state = billingState(c);
              const days = daysUntil(c.nextBillingAt);
              return (
                <li key={c.tenantId}>
                  <Link
                    href={`/platform/clients/${c.tenantId}`}
                    className="flex min-h-14 items-center justify-between gap-3 px-4 py-3 hover:bg-[color:var(--color-surface-muted)]"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{c.name}</span>
                      <span className="block truncate text-sm text-[color:var(--color-text-muted)]">
                        {c.planName ?? 'No plan'}
                        {c.price != null ? ` · ${money(c.price)}` : ''}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {(state === 'OVERDUE' || state === 'GRACE') && (
                        <Badge tone="danger">
                          {days != null && days < 0 ? `${Math.abs(days)}d overdue` : 'Overdue'}
                        </Badge>
                      )}
                      <Badge tone={statusTone(c.status)}>{c.status.replace('_', ' ')}</Badge>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
