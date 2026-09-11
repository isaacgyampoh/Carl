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
  /*
   * Sales figures for someone who may see every sale; stock figures for someone who may view
   * inventory. An inventory manager holds `reports.view` but, deliberately, no access to sales
   * revenue — RLS already returned them zeros, and the page no longer presents those zeros
   * as the business's takings.
   */
  const canSeeSales = hasPermission(auth, Permission.SALES_VIEW_ALL);
  const canSeeStock = hasPermission(auth, Permission.INVENTORY_VIEW);
  // What the business spent is a financial figure, and also needs sight of expenses.
  const canSeeExpenses = canSeeFinancial && hasPermission(auth, Permission.EXPENSES_VIEW);

  const client = await supabase();
  const args = {
    p_tenant_id: auth.tenant.tenantId,
    p_from: from,
    p_to: to,
    p_branch_id: branch?.id,
  };

  const stockArgs = {
    p_tenant_id: auth.tenant.tenantId,
    ...(branch ? { p_branch_id: branch.id } : {}),
  };

  const [summary, top, payments, staff, stock, low, spending] = await Promise.all([
    canSeeSales ? client.rpc('sales_summary', args) : null,
    canSeeSales ? client.rpc('top_products', { ...args, p_limit: 10 }) : null,
    canSeeSales ? client.rpc('payment_method_breakdown', args) : null,
    canSeeSales ? client.rpc('staff_sales_summary', args) : null,
    canSeeStock ? client.rpc('inventory_overview', stockArgs) : null,
    canSeeStock ? client.rpc('low_stock_items', { ...stockArgs, p_limit: 50 }) : null,
    canSeeExpenses ? client.rpc('expense_summary', args) : null,
  ]);

  /*
   * Null when the figure cannot be shown, including when the database does not yet have
   * expense_summary (migration 0039). An unavailable figure is left out rather than shown as
   * zero, because "you spent nothing" would be a claim, not an absence.
   */
  const spent = spending && !spending.error ? (spending.data?.[0] ?? null) : null;

  /*
   * Each branch side by side, from the same database aggregate as the headline figures, one
   * call per branch. A business has a handful of branches; nothing is summed in React.
   */
  const branchRows =
    canSeeSales && auth.tenant.branches.length > 1
      ? await Promise.all(
          auth.tenant.branches.map(async (each) => {
            const branchArgs = { ...args, p_branch_id: each.id };
            const [{ data }, branchSpending] = await Promise.all([
              client.rpc('sales_summary', branchArgs),
              spent ? client.rpc('expense_summary', branchArgs) : null,
            ]);
            return {
              id: each.id,
              name: each.name,
              totals: data?.[0],
              spent: branchSpending && !branchSpending.error ? branchSpending.data?.[0] : undefined,
            };
          }),
        )
      : [];

  const totals = summary?.data?.[0];
  const paymentRows = payments?.data ?? [];
  const paymentTotal = paymentRows.reduce((sum, row) => sum + (row.amount ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Reports"
        description={`${label}${branch ? ` · ${branch.name}` : ''}. Figures use the time each sale was made, not when it reached the server.`}
      />

      <RangePicker current={key} />

      {canSeeSales && (
        <>
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

          {canSeeFinancial && (
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Stat
                label="Cost of sales"
                value={formatMoney(totals?.cost ?? 0)}
                hint="What the goods sold cost you"
              />
              {spent && (
                <>
                  <Stat
                    label="Expenses"
                    value={formatMoney(spent.total ?? 0)}
                    hint={
                      (spent.pending_count ?? 0) > 0
                        ? `${formatMoney(spent.pending_total ?? 0)} awaiting approval`
                        : `${(spent.expense_count ?? 0).toLocaleString('en-GH')} approved`
                    }
                    tone={(spent.pending_count ?? 0) > 0 ? 'warning' : 'neutral'}
                  />
                  <Stat
                    label="Net after expenses"
                    value={formatMoney((totals?.profit ?? 0) - (spent.total ?? 0))}
                    hint="Gross profit less approved expenses"
                    tone={(totals?.profit ?? 0) - (spent.total ?? 0) >= 0 ? 'positive' : 'danger'}
                  />
                </>
              )}
            </div>
          )}

          {branchRows.length > 0 && (
            <Card className="mt-5 overflow-hidden">
              <CardHeader
                title="By branch"
                description={`Every branch over ${label.toLowerCase()}.`}
              />
              <Table>
                <THead>
                  <TR>
                    <TH>Branch</TH>
                    <TH numeric>Sales</TH>
                    <TH numeric>Transactions</TH>
                    {canSeeFinancial && <TH numeric>Gross profit</TH>}
                    {spent && <TH numeric>Expenses</TH>}
                    {spent && <TH numeric>Net</TH>}
                  </TR>
                </THead>
                <TBody>
                  {branchRows.map((row) => (
                    <TR key={row.id}>
                      <TD className="font-medium">{row.name}</TD>
                      <TD numeric>{formatMoney(row.totals?.gross ?? 0)}</TD>
                      <TD numeric>{(row.totals?.sales_count ?? 0).toLocaleString('en-GH')}</TD>
                      {canSeeFinancial && <TD numeric>{formatMoney(row.totals?.profit ?? 0)}</TD>}
                      {spent && <TD numeric>{formatMoney(row.spent?.total ?? 0)}</TD>}
                      {spent && (
                        <TD numeric>
                          {formatMoney((row.totals?.profit ?? 0) - (row.spent?.total ?? 0))}
                        </TD>
                      )}
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Card>
          )}

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <Card className="overflow-hidden">
              <CardHeader title="Best sellers" description="By revenue over the period." />
              {(top?.data ?? []).length === 0 ? (
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
                    {(top?.data ?? []).map((row) => (
                      <TR key={row.product_id ?? row.product_name}>
                        <TD className="font-medium">{row.product_name}</TD>
                        <TD numeric>
                          {formatQuantity(Math.round((row.quantity_sold ?? 0) * 1000))}
                        </TD>
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
                        <TD className="capitalize">
                          {row.method?.replace(/_/g, ' ').toLowerCase()}
                        </TD>
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
            {(staff?.data ?? []).length === 0 ? (
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
                  {(staff?.data ?? []).map((row) => (
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
      )}

      {canSeeStock && (
        <section aria-label="Stock" className="mt-5 space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat
              label="Products"
              value={Number(stock?.data?.[0]?.products ?? 0).toLocaleString('en-GH')}
            />
            <Stat
              label="Low stock"
              value={Number(stock?.data?.[0]?.low_stock ?? 0).toLocaleString('en-GH')}
              tone={Number(stock?.data?.[0]?.low_stock ?? 0) > 0 ? 'warning' : 'neutral'}
            />
            <Stat
              label="Out of stock"
              value={Number(stock?.data?.[0]?.out_of_stock ?? 0).toLocaleString('en-GH')}
              tone={Number(stock?.data?.[0]?.out_of_stock ?? 0) > 0 ? 'danger' : 'neutral'}
            />
          </div>

          <Card className="overflow-hidden">
            <CardHeader
              title="Low and out of stock"
              description="Tracked products at or below their reorder level, as of now."
            />
            {(low?.data ?? []).length === 0 ? (
              <EmptyState title="Nothing to reorder" />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Product</TH>
                    <TH>SKU</TH>
                    <TH numeric>In stock</TH>
                    <TH numeric>Reorder at</TH>
                  </TR>
                </THead>
                <TBody>
                  {(low?.data ?? []).map((row) => (
                    <TR key={`${row.product_id}-${row.branch_id}`}>
                      <TD className="font-medium">{row.name}</TD>
                      <TD className="font-mono text-xs">{row.sku ?? '—'}</TD>
                      <TD numeric>{Number(row.quantity).toLocaleString('en-GH')}</TD>
                      <TD numeric>{Number(row.reorder_level).toLocaleString('en-GH')}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </section>
      )}

      {!canSeeSales && !canSeeStock && (
        <EmptyState
          title="No reports for your role"
          description="Ask the business owner if you need access to sales or stock reports."
        />
      )}
    </>
  );
}
