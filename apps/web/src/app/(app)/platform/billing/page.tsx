import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, CardHeader, EmptyState, Stat } from '@carl/ui';
import { Currency, formatMoney } from '@carl/shared';

import { PageHeader } from '@/components/page-header';
import { requirePlatformAdmin } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { billingState, daysUntil, listClients, type ClientRow } from '@/server/platform-queries';

export const metadata: Metadata = { title: 'Billing · Carl platform' };
export const dynamic = 'force-dynamic';

/**
 * Who owes money, and when.
 *
 * Carl's subscriptions are collected by a person ringing people up, so this is organised
 * by urgency rather than by account: overdue first, then today, then the week ahead. Each
 * row carries the phone number, because the next action is almost always a call.
 */
export default async function BillingPage() {
  await requirePlatformAdmin();
  const client = await supabase();

  const [clients, recentPayments] = await Promise.all([
    listClients({ limit: 500, sort: 'due' }),
    client
      .from('subscription_payments')
      .select('id, tenant_id, amount, currency_code, method, reference, paid_at, tenants(name)')
      .order('paid_at', { ascending: false })
      .limit(10),
  ]);

  const withState = clients
    .filter((c) => c.nextBillingAt && c.status !== 'CANCELLED')
    .map((c) => ({ client: c, state: billingState(c), days: daysUntil(c.nextBillingAt) ?? 0 }));

  const overdue = withState.filter((r) => r.state === 'OVERDUE' || r.state === 'GRACE');
  const today = withState.filter((r) => r.state === 'DUE' || r.days === 0);
  const week = withState.filter((r) => r.state === 'DUE_SOON' && r.days > 0 && r.days <= 7);
  const month = withState.filter((r) => r.days > 7 && r.days <= 30);

  const currency = (clients[0]?.currencyCode as Currency) ?? Currency.GHS;
  const money = (minor: number) => formatMoney(minor, currency);
  const sum = (rows: typeof withState) => rows.reduce((t, r) => t + (r.client.price ?? 0), 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Billing"
        description="Subscriptions due, overdue and recently collected."
      />

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Overdue"
          value={money(sum(overdue))}
          hint={`${overdue.length} ${overdue.length === 1 ? 'client' : 'clients'}`}
          tone={overdue.length > 0 ? 'danger' : 'neutral'}
        />
        <Stat
          label="Due today"
          value={money(sum(today))}
          hint={`${today.length} clients`}
          tone={today.length > 0 ? 'warning' : 'neutral'}
        />
        <Stat label="Next 7 days" value={money(sum(week))} hint={`${week.length} clients`} />
        <Stat label="Next 30 days" value={money(sum(month))} hint={`${month.length} clients`} />
      </section>

      <Section
        title="Overdue"
        description="Past the due date and the grace period."
        rows={overdue}
        money={money}
        empty="Nothing overdue."
        tone="danger"
      />
      <Section
        title="Due today"
        rows={today}
        money={money}
        empty="Nothing due today."
        tone="warning"
      />
      <Section title="Next 7 days" rows={week} money={money} empty="Nothing due this week." />
      <Section title="Next 30 days" rows={month} money={money} empty="Nothing due this month." />

      <Card>
        <CardHeader title="Recent payments" />
        {recentPayments.data?.length ? (
          <ul className="divide-y divide-[color:var(--color-border)]">
            {recentPayments.data.map((p) => {
              const tenant = p.tenants as { name?: string } | null;
              return (
                <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="min-w-0">
                    <Link
                      href={`/platform/clients/${p.tenant_id}`}
                      className="block truncate font-medium underline-offset-4 hover:underline"
                    >
                      {tenant?.name ?? 'Unknown'}
                    </Link>
                    <span className="block truncate text-sm text-[color:var(--color-text-muted)]">
                      {new Date(p.paid_at).toLocaleDateString('en-GB')} ·{' '}
                      {p.method.replace('_', ' ').toLowerCase()}
                      {p.reference ? ` · ${p.reference}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {formatMoney(p.amount, (p.currency_code as Currency) ?? currency)}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState title="No payments recorded yet" />
        )}
      </Card>
    </div>
  );
}

/** One urgency band. Extracted because there are four of them and they differ only in data. */
function Section({
  title,
  description,
  rows,
  money,
  empty,
  tone,
}: {
  title: string;
  description?: string;
  rows: { client: ClientRow; days: number }[];
  money: (minor: number) => string;
  empty: string;
  tone?: 'danger' | 'warning';
}) {
  return (
    <Card>
      <CardHeader
        title={title}
        {...(description ? { description } : {})}
        action={
          rows.length > 0 ? (
            <span className="text-sm tabular-nums">
              {money(rows.reduce((t, r) => t + (r.client.price ?? 0), 0))}
            </span>
          ) : undefined
        }
      />
      {rows.length === 0 ? (
        <EmptyState title={empty} />
      ) : (
        <ul className="divide-y divide-[color:var(--color-border)]">
          {rows.map(({ client, days }) => (
            <li key={client.tenantId} className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="min-w-0">
                <Link
                  href={`/platform/clients/${client.tenantId}`}
                  className="block truncate font-medium underline-offset-4 hover:underline"
                >
                  {client.name}
                </Link>
                <span className="block truncate text-sm text-[color:var(--color-text-muted)]">
                  {client.contactPerson ?? '—'}
                  {client.phone ? ` · ${client.phone}` : ''}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                <span className="tabular-nums">
                  {client.price != null ? money(client.price) : '—'}
                </span>
                {tone ? (
                  <Badge tone={tone}>
                    {days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? 'Today' : `${days}d`}
                  </Badge>
                ) : (
                  <span className="text-sm text-[color:var(--color-text-muted)]">
                    in {days} {days === 1 ? 'day' : 'days'}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
