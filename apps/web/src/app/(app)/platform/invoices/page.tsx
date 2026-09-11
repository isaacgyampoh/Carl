import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, EmptyState, Stat, buttonClasses, statusTone } from '@carl/ui';
import { Currency, formatMoney } from '@carl/shared';

import { PageHeader } from '@/components/page-header';
import { listInvoices, type InvoiceStatus } from '@/server/platform-queries';

export const metadata: Metadata = { title: 'Invoices · Carl platform' };
export const dynamic = 'force-dynamic';

const STATUSES: readonly (InvoiceStatus | 'ALL')[] = [
  'ALL',
  'ISSUED',
  'OVERDUE',
  'PAID',
  'DRAFT',
  'CANCELLED',
];

const date = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
    : '—';

/**
 * Every invoice, across every client.
 *
 * The question this answers that a client profile cannot: how much has been billed and not
 * collected, in total. Issuing and settling happen on the client's own page, where the
 * subscription context is — this is the ledger view, not a second place to do the work.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await searchParams;
  const status = STATUSES.find((s) => s === params.status) ?? 'ALL';
  const invoices = await listInvoices(status);

  const currency = (invoices[0]?.currencyCode as Currency) ?? Currency.GHS;
  const money = (minor: number) => formatMoney(minor, currency);
  const unpaid = invoices.filter((i) => i.status === 'ISSUED' || i.status === 'OVERDUE');
  const overdue = invoices.filter((i) => i.status === 'OVERDUE');

  return (
    <div className="space-y-4">
      <PageHeader
        title="Invoices"
        description={`${invoices.length} ${invoices.length === 1 ? 'invoice' : 'invoices'}`}
      />

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat
          label="Outstanding"
          value={money(unpaid.reduce((t, i) => t + i.amount, 0))}
          hint={`${unpaid.length} unpaid`}
          tone={unpaid.length > 0 ? 'warning' : 'neutral'}
        />
        <Stat
          label="Overdue"
          value={money(overdue.reduce((t, i) => t + i.amount, 0))}
          hint={`${overdue.length} past due`}
          tone={overdue.length > 0 ? 'danger' : 'neutral'}
        />
        <Stat
          label="Collected"
          value={money(
            invoices.filter((i) => i.status === 'PAID').reduce((t, i) => t + i.amount, 0),
          )}
        />
      </section>

      <div className="-mx-4 overflow-x-auto px-4">
        <div className="flex gap-2 pb-1">
          {STATUSES.map((s) => (
            <Link
              key={s}
              href={s === 'ALL' ? '/platform/invoices' : `/platform/invoices?status=${s}`}
              className={buttonClasses({ variant: s === status ? 'primary' : 'ghost' })}
            >
              {s === 'ALL' ? 'All' : s.toLowerCase()}
            </Link>
          ))}
        </div>
      </div>

      {invoices.length === 0 ? (
        <Card>
          <EmptyState
            title="No invoices"
            description="Issue one from a client's page, where the subscription is."
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-[color:var(--color-border)]">
            {invoices.map((i) => (
              <li key={i.id}>
                <Link
                  href={`/platform/clients/${i.tenantId}`}
                  className="block min-h-16 px-4 py-3 hover:bg-[color:var(--color-surface-muted)]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{i.tenantName}</div>
                      <div className="truncate text-sm text-[color:var(--color-ink-muted)]">
                        {i.invoiceNumber}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="tabular-nums">
                        {formatMoney(i.amount, (i.currencyCode as Currency) ?? currency)}
                      </span>
                      <Badge tone={statusTone(i.status)}>{i.status}</Badge>
                    </div>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 text-sm text-[color:var(--color-ink-muted)]">
                    <span>
                      {date(i.periodStart)} – {date(i.periodEnd)}
                    </span>
                    <span>due {date(i.dueAt)}</span>
                    {i.paidAt && <span>paid {date(i.paidAt)}</span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
