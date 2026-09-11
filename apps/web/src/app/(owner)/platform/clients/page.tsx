import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, EmptyState, buttonClasses, statusTone } from '@carl/ui';
import { Currency, formatMoney } from '@carl/shared';

import { PageHeader } from '@/components/page-header';
import { billingState, daysUntil, listClients, type ClientStatus } from '@/server/platform-queries';

export const metadata: Metadata = { title: 'Clients · Carl platform' };
export const dynamic = 'force-dynamic';

const STATUSES: readonly (ClientStatus | 'ALL')[] = [
  'ALL',
  'TRIAL',
  'ACTIVE',
  'GRACE_PERIOD',
  'SUSPENDED',
  'CANCELLED',
];

const SORTS = [
  ['newest', 'Newest'],
  ['due', 'Next payment'],
  ['name', 'Name'],
  ['oldest', 'Oldest'],
] as const;

/**
 * Every business on Carl.
 *
 * Searching and filtering happen in the database. Fetching every tenant and filtering in
 * the browser would put the entire customer list — names, phone numbers, billing — into a
 * response that only needed to contain one row.
 */
export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; sort?: string }>;
}) {
  const params = await searchParams;
  // Narrowed by lookup rather than cast: an unknown ?status= falls back rather than
  // reaching the query as an arbitrary string.
  const status = STATUSES.find((s) => s === params.status) ?? 'ALL';
  const sort = SORTS.find(([key]) => key === params.sort)?.[0] ?? 'newest';

  const clients = await listClients({
    ...(params.q ? { search: params.q } : {}),
    status,
    sort,
  });

  const href = (next: Record<string, string>) => {
    const search = new URLSearchParams({
      ...(params.q ? { q: params.q } : {}),
      ...(status !== 'ALL' ? { status } : {}),
      ...(sort !== 'newest' ? { sort } : {}),
      ...next,
    });
    for (const [k, v] of [...search.entries()]) if (!v || v === 'ALL') search.delete(k);
    const qs = search.toString();
    return `/platform/clients${qs ? `?${qs}` : ''}`;
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Clients"
        description={`${clients.length.toLocaleString('en-GH')} ${clients.length === 1 ? 'business' : 'businesses'}`}
        action={
          <Link href="/platform/onboarding" className={buttonClasses({ variant: 'primary' })}>
            Add client
          </Link>
        }
      />

      {/* A plain GET form, so a filtered list is a shareable URL and works without JS. */}
      <form method="get" className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={params.q ?? ''}
          placeholder="Business, contact, phone or email"
          aria-label="Search clients"
          className="h-11 min-w-0 flex-1 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 outline-none focus-visible:outline-2 focus-visible:outline-[color:var(--color-brand)]"
        />
        {status !== 'ALL' && <input type="hidden" name="status" value={status} />}
        {sort !== 'newest' && <input type="hidden" name="sort" value={sort} />}
        <button type="submit" className={buttonClasses({ variant: 'secondary' })}>
          Search
        </button>
      </form>

      {/* Scrolls rather than wrapping: filter chips must not push the list below the fold. */}
      <div className="-mx-4 overflow-x-auto px-4">
        <div className="flex flex-wrap gap-2 pb-1">
          {STATUSES.map((s) => (
            <Link
              key={s}
              href={href({ status: s })}
              className={buttonClasses({ variant: s === status ? 'primary' : 'ghost' })}
            >
              {s === 'ALL' ? 'All' : s.replace('_', ' ').toLowerCase()}
            </Link>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-[color:var(--color-ink-muted)]">Sort</span>
        {SORTS.map(([key, label]) => (
          <Link
            key={key}
            href={href({ sort: key })}
            className={
              key === sort
                ? 'inline-flex min-h-10 items-center rounded-full bg-[color:var(--color-surface-muted)] px-3 py-1 font-medium'
                : 'inline-flex min-h-10 items-center rounded-full px-3 py-1 text-[color:var(--color-ink-muted)] hover:bg-[color:var(--color-surface-muted)]'
            }
          >
            {label}
          </Link>
        ))}
      </div>

      {clients.length === 0 ? (
        <Card>
          <EmptyState
            title={params.q ? 'No clients match that search' : 'No clients yet'}
            description={
              params.q
                ? 'Try a business name, contact, phone number or email.'
                : 'Onboard the first business to start using Carl.'
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-[color:var(--color-border)]">
            {clients.map((c) => {
              const state = billingState(c);
              const days = daysUntil(c.nextBillingAt);
              const currency = (c.currencyCode as Currency) ?? Currency.GHS;
              return (
                <li key={c.tenantId}>
                  <Link
                    href={`/platform/clients/${c.tenantId}`}
                    className="block min-h-16 px-4 py-3 hover:bg-[color:var(--color-surface-muted)]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{c.name}</div>
                        <div className="truncate text-sm text-[color:var(--color-ink-muted)]">
                          {c.contactPerson ?? c.email ?? c.slug}
                          {c.phone ? ` · ${c.phone}` : ''}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <Badge tone={statusTone(c.status)}>{c.status.replace('_', ' ')}</Badge>
                        {c.price != null && (
                          <span className="text-sm tabular-nums">
                            {formatMoney(c.price, currency)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[color:var(--color-ink-muted)]">
                      <span>{c.planName ?? 'No plan'}</span>
                      <span>
                        {c.branchCount} {c.branchCount === 1 ? 'branch' : 'branches'}
                      </span>
                      <span>
                        {c.deviceCount} {c.deviceCount === 1 ? 'terminal' : 'terminals'}
                      </span>
                      {days != null &&
                        (state === 'OVERDUE' || state === 'GRACE' ? (
                          <span className="font-medium text-[color:var(--color-danger)]">
                            {days < 0 ? `${Math.abs(days)} days overdue` : 'Overdue'}
                          </span>
                        ) : state === 'DUE_SOON' || state === 'DUE' ? (
                          <span className="font-medium text-[color:var(--color-warning)]">
                            Due in {Math.max(days, 0)} {days === 1 ? 'day' : 'days'}
                          </span>
                        ) : null)}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
