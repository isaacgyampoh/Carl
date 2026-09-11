import type { Metadata } from 'next';
import Link from 'next/link';
import { activeBranch, hasPermission } from '@carl/application';
import { Permission } from '@carl/domain';
import { Currency, formatMoney } from '@carl/shared';
import { Badge, Card, CardHeader, EmptyState, Stat, buttonClasses } from '@carl/ui';

import { PageHeader } from '@/components/page-header';
import { PrintButton } from '@/components/print-button';
import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

export const metadata: Metadata = { title: 'Day report' };
export const dynamic = 'force-dynamic';

interface CashSession {
  id: string;
  status: string;
  opening_float: number;
  cash_sales: number;
  cash_refunds: number;
  cash_in: number;
  cash_out: number;
  cash_expenses: number;
  expected_cash: number | null;
  counted_cash: number | null;
  variance: number | null;
  opened_at: string;
  closed_at: string | null;
  branches: { name: string } | null;
}

/**
 * The end of a trading day, on one page.
 *
 * What a shop reads out when it closes: what was sold, how it was paid for, what was refunded,
 * what was spent, and whether the cash in the drawer matches what should be there. It is the
 * "Z report" a till roll prints, and it is laid out to be printed and filed.
 *
 * Figures use the moment each sale was made, never when it reached the server, so a day's total
 * does not change when a till that was offline syncs.
 */
export default async function DayReportPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; branch?: string }>;
}) {
  const auth = await requirePermission(Permission.REPORTS_VIEW);
  const params = await searchParams;
  const branch = activeBranch(auth);

  /*
   * The day, as the shop means it: midnight to midnight where the business trades. Carl's
   * customers are in Ghana, which keeps UTC the year round, so the server's own day boundaries
   * are the shop's. A business in another timezone needs this to read its configured one.
   */
  const today = new Date().toISOString().slice(0, 10);
  const wanted = params.date ?? '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(wanted) ? wanted : today;
  const from = new Date(`${date}T00:00:00.000Z`);
  const to = new Date(from.getTime() + 86_400_000);
  const previous = new Date(from.getTime() - 86_400_000).toISOString().slice(0, 10);
  const next = to.toISOString().slice(0, 10);

  const client = await supabase();
  const args = {
    p_tenant_id: auth.tenant.tenantId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    ...(branch ? { p_branch_id: branch.id } : {}),
  };
  const canSeeFinancial = hasPermission(auth, Permission.REPORTS_VIEW_FINANCIAL);

  const [summary, payments, staff, expenses, sessions] = await Promise.all([
    client.rpc('sales_summary', args),
    client.rpc('payment_method_breakdown', args),
    client.rpc('staff_sales_summary', args),
    canSeeFinancial && hasPermission(auth, Permission.EXPENSES_VIEW)
      ? client.rpc('expense_summary', args)
      : null,
    client
      .from('cash_sessions')
      .select(
        'id, status, opening_float, cash_sales, cash_refunds, cash_in, cash_out, cash_expenses, expected_cash, counted_cash, variance, opened_at, closed_at, branches(name)',
      )
      .gte('opened_at', from.toISOString())
      .lt('opened_at', to.toISOString())
      .order('opened_at', { ascending: true })
      .returns<CashSession[]>(),
  ]);

  const totals = summary.data?.[0];
  // Carl's businesses trade in one currency; a mixed total would be a wrong number.
  const currency = Currency.GHS;
  const money = (minor: number | null | undefined) => formatMoney(minor ?? 0, currency);
  const spent = expenses?.data?.[0] ?? null;
  const drawers = sessions.data ?? [];
  const readable = new Date(`${date}T12:00:00.000Z`).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Day report"
        description={`${readable}${branch ? ` · ${branch.name}` : ''}`}
        action={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <Link
              href={`/reports/day?date=${previous}`}
              className={buttonClasses({ variant: 'ghost', size: 'sm' })}
            >
              Previous day
            </Link>
            {next <= today && (
              <Link
                href={`/reports/day?date=${next}`}
                className={buttonClasses({ variant: 'ghost', size: 'sm' })}
              >
                Next day
              </Link>
            )}
            <PrintButton label="Print this report" />
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Sales" value={money(totals?.gross)} />
        <Stat
          label="Transactions"
          value={(totals?.sales_count ?? 0).toLocaleString('en-GH')}
          hint={`Average ${money(totals?.average_sale)}`}
        />
        <Stat
          label="Refunded"
          value={money(totals?.refunds)}
          tone={(totals?.refunds ?? 0) > 0 ? 'warning' : 'neutral'}
        />
        {canSeeFinancial && (
          <Stat
            label="Gross profit"
            value={money(totals?.profit)}
            tone={(totals?.profit ?? 0) >= 0 ? 'positive' : 'danger'}
          />
        )}
      </div>

      <Card>
        <CardHeader title="Taken by" description="Every payment recorded against this day." />
        {(payments.data ?? []).length === 0 ? (
          <EmptyState
            title="Nothing was taken"
            description="No payment was recorded on this day."
          />
        ) : (
          <ul className="divide-y divide-[color:var(--color-border)]">
            {(payments.data ?? []).map((row) => (
              <li key={row.method} className="flex items-center justify-between px-4 py-3">
                <span className="text-sm font-medium">{row.method}</span>
                <span className="text-sm tabular-nums">{money(row.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Cash drawers" description="Counted against what Carl expected." />
        {drawers.length === 0 ? (
          <EmptyState
            title="No drawer was opened"
            description="Either nothing was sold for cash, or the till was not opened through Carl."
          />
        ) : (
          <ul className="divide-y divide-[color:var(--color-border)]">
            {drawers.map((session) => (
              <li key={session.id} className="space-y-1 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{session.branches?.name ?? ''}</span>
                  <Badge tone={session.status === 'OPEN' ? 'warning' : 'neutral'}>
                    {session.status}
                  </Badge>
                  {session.variance !== null && session.variance !== 0 && (
                    <Badge tone={session.variance < 0 ? 'danger' : 'warning'}>
                      {session.variance < 0 ? 'Short' : 'Over'} {money(Math.abs(session.variance))}
                    </Badge>
                  )}
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                  {[
                    ['Opening float', session.opening_float],
                    ['Cash sales', session.cash_sales],
                    ['Refunds', session.cash_refunds],
                    ['Paid in', session.cash_in],
                    ['Paid out', session.cash_out],
                    ['Expenses', session.cash_expenses],
                    ['Expected', session.expected_cash],
                    ['Counted', session.counted_cash],
                  ].map(([label, value]) => (
                    <div key={String(label)}>
                      <dt className="text-[color:var(--color-ink-muted)]">{label}</dt>
                      <dd className="tabular-nums">{money(value as number | null)}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {spent && (
        <Card>
          <CardHeader title="Spent" description="Approved expenses recorded against this day." />
          <div className="grid gap-4 p-4 sm:grid-cols-3">
            <Stat label="Expenses" value={money(spent.total)} />
            <Stat
              label="Awaiting approval"
              value={money(spent.pending_total)}
              tone={(spent.pending_count ?? 0) > 0 ? 'warning' : 'neutral'}
            />
            {canSeeFinancial && (
              <Stat
                label="Net after expenses"
                value={money((totals?.profit ?? 0) - (spent.total ?? 0))}
                tone={(totals?.profit ?? 0) - (spent.total ?? 0) >= 0 ? 'positive' : 'danger'}
              />
            )}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title="Who sold" description="Each person's takings on this day." />
        {(staff.data ?? []).length === 0 ? (
          <EmptyState title="Nobody sold anything" description="No sale was recorded." />
        ) : (
          <ul className="divide-y divide-[color:var(--color-border)]">
            {(staff.data ?? []).map((row) => (
              <li key={row.cashier_id} className="flex items-center justify-between px-4 py-3">
                <span className="text-sm font-medium">{row.cashier_name}</span>
                <span className="text-sm tabular-nums">
                  {money(row.gross)} · {(row.sales_count ?? 0).toLocaleString('en-GH')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
