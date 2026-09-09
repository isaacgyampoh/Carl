import type { Metadata } from 'next';
import { Permission } from '@carl/domain';
import { activeBranch, hasPermission } from '@carl/application';
import { formatMoney, formatQuantity } from '@carl/shared';
import { Card, CardHeader, EmptyState, Stat, Table, TBody, TD, TH, THead, TR } from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';
import { RangePicker, resolveRange } from './range-picker';

export const metadata: Metadata = { title: 'Reports' };
export const dynamic = 'force-dynamic';

/**
 * Reporting.
 *
 * Every figure comes from a PostgreSQL function that aggregates over the caller's own
 * rows. Nothing on this page is summed in React — a shop with a year of trade would
 * otherwise ship tens of thousands of rows to a browser to display a dozen numbers.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const auth = await requirePermission(Permission.REPORTS_VIEW);
  const params = await searchParams;
  const branch = activeBranch(auth);
  const { from, to, label, key } = resolveRange(params.range, params.from, params.to);

  // Margin and cost are a separate permission from seeing sales volume.
  const canSeeFinancial = hasPermission(auth, Permission.REPORTS_VIEW_FINANCIAL);

  const client = await supabase();
  const args = {
    p_tenant_id: auth.tenant.tenantId,
    p_from: from,
    p_to: to,
    p_branch_id: branch?.id,
  };

  const [summary, top, payments, staff] = await Promise.all([
    client.rpc('sales_summary', args),
    client.rpc('top_products', { ...args, p_limit: 10 }),
    client.rpc('payment_method_breakdown', args),
    client.rpc('staff_sales_summary', args),
  ]);

  const totals = summary.data?.[0];
  const paymentRows = payments.data ?? [];
  const paymentTotal = paymentRows.reduce((sum, row) => sum + (row.amount ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Reports"
        description={`${label}${branch ? ` · ${branch.name}` : ''}. Figures use the time each sale was made, not when it reached the server.`}
      />

      <RangePicker current={key} />

      <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Sales" value={formatMoney(totals?.gross ?? 0)} />
        <Stat
          label="Transactions"
          value={(totals?.sales_count ?? 0).toLocaleString('en-GH')}
          hint={`Average ${formatMoney(totals?.average_sale ?? 0)}`}
        />
        {canSeeFinancial && (
          <Stat
            label="Gross profit"
            value={formatMoney(totals?.profit ?? 0)}
            tone={(totals?.profit ?? 0) >= 0 ? 'positive' : 'danger'}
          />
        )}
        <Stat
          label="Refunded"
          value={formatMoney(totals?.refunds ?? 0)}
          tone={(totals?.refunds ?? 0) > 0 ? 'warning' : 'neutral'}
        />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title="Best sellers" description="By revenue over the period." />
          {(top.data ?? []).length === 0 ? (
            <EmptyState title="No sales in this period" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Product</TH>
                  <TH numeric>Sold</TH>
                  <TH numeric>Revenue</TH>
                  {canSeeFinancial && <TH numeric>Profit</TH>}
                </TR>
              </THead>
              <TBody>
                {(top.data ?? []).map((row) => (
                  <TR key={row.product_id ?? row.product_name}>
                    <TD className="font-medium">{row.product_name}</TD>
                    <TD numeric>{formatQuantity(Math.round((row.quantity_sold ?? 0) * 1000))}</TD>
                    <TD numeric>{formatMoney(row.revenue ?? 0)}</TD>
                    {canSeeFinancial && <TD numeric>{formatMoney(row.profit ?? 0)}</TD>}
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        <Card className="overflow-hidden">
          <CardHeader
            title="How customers paid"
            description="What should be in the drawer, versus what came in electronically."
          />
          {paymentRows.length === 0 ? (
            <EmptyState title="No payments in this period" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Method</TH>
                  <TH numeric>Count</TH>
                  <TH numeric>Amount</TH>
                  <TH numeric>Share</TH>
                </TR>
              </THead>
              <TBody>
                {paymentRows.map((row) => (
                  <TR key={row.method}>
                    <TD className="capitalize">{row.method?.replace(/_/g, ' ').toLowerCase()}</TD>
                    <TD numeric>{(row.payment_count ?? 0).toLocaleString('en-GH')}</TD>
                    <TD numeric>{formatMoney(row.amount ?? 0)}</TD>
                    <TD numeric className="text-[color:var(--color-ink-muted)]">
                      {paymentTotal > 0
                        ? `${Math.round(((row.amount ?? 0) / paymentTotal) * 100)}%`
                        : '—'}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>

      <Card className="mt-5 overflow-hidden">
        <CardHeader title="By staff member" description="Who took the sales over the period." />
        {(staff.data ?? []).length === 0 ? (
          <EmptyState title="No sales in this period" />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Staff</TH>
                <TH numeric>Transactions</TH>
                <TH numeric>Sales</TH>
                <TH numeric>Refunded</TH>
              </TR>
            </THead>
            <TBody>
              {(staff.data ?? []).map((row) => (
                <TR key={row.cashier_id ?? row.cashier_name}>
                  <TD className="font-medium">{row.cashier_name}</TD>
                  <TD numeric>{(row.sales_count ?? 0).toLocaleString('en-GH')}</TD>
                  <TD numeric>{formatMoney(row.gross ?? 0)}</TD>
                  <TD numeric>
                    {(row.refunds ?? 0) > 0 ? (
                      <span className="text-[color:var(--color-warning)]">
                        {formatMoney(row.refunds ?? 0)}
                      </span>
                    ) : (
                      '—'
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
