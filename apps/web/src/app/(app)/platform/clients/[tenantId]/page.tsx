import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Card, CardHeader, EmptyState, Stat, statusTone } from '@carl/ui';
import { Currency, formatMoney } from '@carl/shared';

import { PageHeader } from '@/components/page-header';
import { requirePlatformAdmin } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { billingState, daysUntil, listClients } from '@/server/platform-queries';
import { ClientActions } from './client-actions';
import { FeeEditor } from './fee-editor';

export const metadata: Metadata = { title: 'Client · Carl platform' };
export const dynamic = 'force-dynamic';

const date = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';

/**
 * Everything the platform owner needs about one customer, on one page.
 *
 * Structural and commercial records only. There is no sales figure here and no stock
 * level, because a platform administrator cannot read them — the policies stop at the
 * business's own trade, and reading that needs a support grant the customer can see.
 */
export default async function ClientPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  await requirePlatformAdmin();
  const client = await supabase();

  // One round trip each, in parallel — not one query per row of anything.
  const [tenantResult, branches, devices, staff, invoices, payments, activity] = await Promise.all([
    client
      .from('tenants')
      .select(
        'id, name, slug, legal_name, status, contact_person, email, phone, address, currency_code, created_at, suspended_at, suspension_reason, trial_ends_at',
      )
      .eq('id', tenantId)
      .maybeSingle(),
    client
      .from('branches')
      .select('id, name, code, is_active, created_at')
      .eq('tenant_id', tenantId)
      .order('created_at'),
    client
      .from('devices')
      .select('id, name, code, status, branch_id, activated_at, last_seen_at')
      .eq('tenant_id', tenantId)
      .order('created_at'),
    client
      .from('tenant_memberships')
      .select('id, user_id, status, is_owner, created_at, profiles(full_name, email)')
      .eq('tenant_id', tenantId),
    client
      .from('subscription_invoices')
      .select(
        'id, invoice_number, amount, currency_code, status, issued_at, due_at, paid_at, period_start, period_end',
      )
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(12),
    client
      .from('subscription_payments')
      .select('id, amount, currency_code, method, reference, paid_at, period_start, period_end')
      .eq('tenant_id', tenantId)
      .order('paid_at', { ascending: false })
      .limit(12),
    client
      .from('audit_logs')
      .select('id, action, occurred_at, metadata')
      .eq('tenant_id', tenantId)
      .order('occurred_at', { ascending: false })
      .limit(20),
  ]);

  const tenant = tenantResult.data;
  if (!tenant) notFound();

  const [summary] = await listClients({ search: tenant.slug, limit: 1 });
  const currency = (tenant.currency_code as Currency) ?? Currency.GHS;
  const money = (minor: number) => formatMoney(minor, currency);
  const state = summary ? billingState(summary) : 'CURRENT';
  const days = daysUntil(summary?.nextBillingAt ?? null);
  const branchName = new Map((branches.data ?? []).map((b) => [b.id, b.name]));

  const outstanding = (invoices.data ?? [])
    .filter((i) => i.status === 'ISSUED' || i.status === 'OVERDUE')
    .reduce((sum, i) => sum + i.amount, 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title={tenant.name}
        description={[tenant.contact_person, tenant.phone, tenant.email]
          .filter(Boolean)
          .join(' · ')}
        action={<Badge tone={statusTone(tenant.status)}>{tenant.status.replace('_', ' ')}</Badge>}
      />

      {tenant.status === 'SUSPENDED' && tenant.suspension_reason && (
        <Card className="border-[color:var(--color-danger)] p-4">
          <p className="text-sm">
            <span className="font-medium">Suspended {date(tenant.suspended_at)}.</span>{' '}
            {tenant.suspension_reason}
          </p>
        </Card>
      )}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Plan" value={summary?.planName ?? '—'} />
        <Stat label="Billing" value={summary?.price != null ? money(summary.price) : '—'} />
        <Stat
          label="Next payment"
          value={date(summary?.nextBillingAt)}
          tone={
            state === 'OVERDUE' || state === 'GRACE'
              ? 'danger'
              : state === 'DUE_SOON'
                ? 'warning'
                : 'neutral'
          }
          {...(days != null && days < 0 ? { hint: `${Math.abs(days)} days overdue` } : {})}
        />
        <Stat
          label="Outstanding"
          value={outstanding > 0 ? money(outstanding) : '—'}
          tone={outstanding > 0 ? 'warning' : 'neutral'}
        />
      </section>

      <FeeEditor tenantId={tenant.id} currentFee={summary?.price ?? 0} />

      <ClientActions
        tenantId={tenant.id}
        tenantName={tenant.name}
        status={tenant.status}
        subscriptionId={summary?.subscriptionId ?? null}
        defaultAmount={summary?.price ?? 0}
        currencyCode={currency}
        openInvoices={(invoices.data ?? [])
          .filter((i) => i.status === 'ISSUED' || i.status === 'OVERDUE')
          .map((i) => ({ id: i.id, number: i.invoice_number, amount: i.amount }))}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Business" />
          <dl className="grid grid-cols-2 gap-3 p-4 text-sm">
            {[
              ['Legal name', tenant.legal_name ?? '—'],
              ['Identifier', tenant.slug],
              ['Address', tenant.address ?? '—'],
              ['Onboarded', date(tenant.created_at)],
              ['Trial ends', date(tenant.trial_ends_at)],
              ['Client ID', tenant.id],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-[color:var(--color-ink-muted)]">{label}</dt>
                <dd className="break-words font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card>
          <CardHeader title="Branches" description={`${branches.data?.length ?? 0} total`} />
          {branches.data?.length ? (
            <ul className="divide-y divide-[color:var(--color-border)]">
              {branches.data.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{b.name}</span>
                    <span className="text-sm text-[color:var(--color-ink-muted)]">{b.code}</span>
                  </span>
                  <Badge tone={b.is_active ? 'positive' : 'neutral'}>
                    {b.is_active ? 'Active' : 'Closed'}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No branches" />
          )}
        </Card>

        <Card>
          <CardHeader title="Terminals" description={`${devices.data?.length ?? 0} registered`} />
          {devices.data?.length ? (
            <ul className="divide-y divide-[color:var(--color-border)]">
              {devices.data.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{d.name}</span>
                    <span className="block truncate text-sm text-[color:var(--color-ink-muted)]">
                      {branchName.get(d.branch_id) ?? '—'} · last seen {date(d.last_seen_at)}
                    </span>
                  </span>
                  <Badge tone={statusTone(d.status)}>{d.status.replace('_', ' ')}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="No terminals"
              description="Issue an activation code to set one up."
            />
          )}
        </Card>

        <Card>
          <CardHeader title="Staff" description={`${staff.data?.length ?? 0} people`} />
          {staff.data?.length ? (
            <ul className="divide-y divide-[color:var(--color-border)]">
              {staff.data.map((m) => {
                const profile = m.profiles as { full_name?: string; email?: string } | null;
                return (
                  <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {profile?.full_name ?? '—'}
                      </span>
                      <span className="block truncate text-sm text-[color:var(--color-ink-muted)]">
                        {profile?.email ?? ''}
                      </span>
                    </span>
                    {m.is_owner && <Badge tone="brand">Owner</Badge>}
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState title="No staff" />
          )}
        </Card>

        <Card>
          <CardHeader
            title="Invoices"
            action={
              <Link href="/platform/invoices" className="text-sm underline underline-offset-4">
                All
              </Link>
            }
          />
          {invoices.data?.length ? (
            <ul className="divide-y divide-[color:var(--color-border)]">
              {invoices.data.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{i.invoice_number}</span>
                    <span className="text-sm text-[color:var(--color-ink-muted)]">
                      due {date(i.due_at)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="tabular-nums">{money(i.amount)}</span>
                    <Badge tone={statusTone(i.status)}>{i.status}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No invoices yet" />
          )}
        </Card>

        <Card>
          <CardHeader title="Payments" />
          {payments.data?.length ? (
            <ul className="divide-y divide-[color:var(--color-border)]">
              {payments.data.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="min-w-0">
                    <span className="block font-medium">{date(p.paid_at)}</span>
                    <span className="block truncate text-sm text-[color:var(--color-ink-muted)]">
                      {p.method.replace('_', ' ').toLowerCase()}
                      {p.reference ? ` · ${p.reference}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">{money(p.amount)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No payments recorded" />
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="Activity" description="Platform actions on this account." />
        {activity.data?.length ? (
          <ul className="divide-y divide-[color:var(--color-border)]">
            {activity.data.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="font-medium">{a.action.replace(/_/g, ' ').toLowerCase()}</span>
                <span className="shrink-0 text-[color:var(--color-ink-muted)]">
                  {new Date(a.occurred_at).toLocaleString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No platform activity yet" />
        )}
      </Card>
    </div>
  );
}
