import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { hasPermission } from '@carl/application';
import { Permission } from '@carl/domain';
import { formatMoney } from '@carl/shared';
import { Card, CardBody, CardHeader, EmptyState, Stat, buttonClasses } from '@carl/ui';

import { requireAuth } from '@/lib/auth';
import { clientAppUrl, desktopDownloads } from '@/lib/downloads';
import { supabase } from '@/lib/supabase';

export const metadata: Metadata = { title: 'Dashboard' };

// Money and stock change constantly; a cached dashboard shows a shop yesterday's takings.
export const dynamic = 'force-dynamic';

interface RecentSale {
  id: string;
  sale_number: string;
  total: number;
  sold_at: string;
  status: string;
}

/**
 * The business dashboard.
 *
 * ## What each person sees
 *
 * A cashier is sent to the till: the business's takings are not theirs to see. Sales figures
 * appear only for someone allowed to see every sale (`sales.view_all`), stock figures only
 * for someone who may view inventory, and profit only with financial reporting.
 *
 * Those are presentation choices. The database is the boundary: every query below is RLS-
 * filtered, so even a page that showed more would receive only the caller's own rows — a
 * cashier's "sales" are their own, an inventory manager's are none.
 *
 * ## Why every figure is computed in PostgreSQL
 *
 * A shop with a year of sales would otherwise ship tens of thousands of rows to a phone to
 * display a dozen numbers. Today, week, month and year come from one pass over one index.
 */
export default async function DashboardPage() {
  const auth = await requireAuth();

  if (!auth.tenant) {
    if (auth.user.isPlatformAdmin) redirect('/platform');
    return (
      <EmptyState
        title="No business attached to your account"
        description="Your account is not operating in a business right now. Open your business's own Carl address and sign in there, or contact whoever manages Carl for your organisation."
      />
    );
  }

  const canReport = hasPermission(auth, Permission.REPORTS_VIEW);
  const canSell = hasPermission(auth, Permission.SALES_CREATE);
  // A cashier's place is the till.
  if (!canReport && canSell) redirect('/pos');

  const canSeeSales = hasPermission(auth, Permission.SALES_VIEW_ALL);
  const canSeeProfit = hasPermission(auth, Permission.REPORTS_VIEW_FINANCIAL);
  const canSeeStock = hasPermission(auth, Permission.INVENTORY_VIEW);
  const canSetUpTerminals = hasPermission(auth, Permission.DEVICES_MANAGE);

  const tenantId = auth.tenant.tenantId;
  const branchId = auth.tenant.activeBranchId ?? undefined;
  const scope = { p_tenant_id: tenantId, ...(branchId ? { p_branch_id: branchId } : {}) };
  const client = await supabase();

  const [todayResult, periodsResult, stockResult, lowResult, recentResult, tenantResult] =
    await Promise.all([
      canSeeSales ? client.rpc('tenant_dashboard_today', scope) : null,
      canSeeSales ? client.rpc('tenant_sales_periods', scope) : null,
      canSeeStock ? client.rpc('inventory_overview', scope) : null,
      canSeeStock ? client.rpc('low_stock_items', { ...scope, p_limit: 8 }) : null,
      canSeeSales
        ? (() => {
            let query = client
              .from('sales')
              .select('id, sale_number, total, sold_at, status')
              .eq('tenant_id', tenantId)
              .order('sold_at', { ascending: false })
              .limit(8);
            if (branchId) query = query.eq('branch_id', branchId);
            return query.returns<RecentSale[]>();
          })()
        : null,
      canSetUpTerminals
        ? client.from('tenants').select('slug').eq('id', tenantId).maybeSingle()
        : null,
    ]);

  const today = todayResult?.data?.[0];
  const periods = periodsResult?.data?.[0];
  const stock = stockResult?.data?.[0];
  const low = lowResult?.data ?? [];
  const recent = recentResult?.data ?? [];
  const gross = Number(today?.gross ?? 0);
  const cash = Number(today?.cash ?? 0);
  const momo = Number(today?.momo ?? 0);
  const profit = gross - Number(today?.cost ?? 0);
  const branchNote = auth.tenant.branches.length > 1 ? ' for the selected branch' : '';
  const slug = tenantResult?.data?.slug ?? null;
  const windows = desktopDownloads().find((d) => d.platform === 'Windows');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{auth.tenant.tenantName}</h1>
          <p className="mt-0.5 text-sm text-[color:var(--color-ink-muted)]">
            Your business at a glance{branchNote}.
          </p>
        </div>
        {canSell && (
          <Link href="/pos" className={buttonClasses({ size: 'lg' })}>
            Open point of sale
          </Link>
        )}
      </div>

      {canSeeSales && (
        <>
          <section aria-label="Today" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Sales today" value={formatMoney(gross)} />
            <Stat
              label="Transactions today"
              value={Number(today?.sales_count ?? 0).toLocaleString('en-GH')}
            />
            <Stat label="Cash" value={formatMoney(cash)} />
            <Stat label="Mobile money" value={formatMoney(momo)} />
          </section>

          <section aria-label="This period" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="This week"
              value={formatMoney(Number(periods?.week_gross ?? 0))}
              hint={`${Number(periods?.week_count ?? 0).toLocaleString('en-GH')} sales`}
            />
            <Stat
              label="This month"
              value={formatMoney(Number(periods?.month_gross ?? 0))}
              hint={`${Number(periods?.month_count ?? 0).toLocaleString('en-GH')} sales`}
            />
            <Stat
              label="This year"
              value={formatMoney(Number(periods?.year_gross ?? 0))}
              hint={`${Number(periods?.year_count ?? 0).toLocaleString('en-GH')} sales`}
            />
            {canSeeProfit && (
              <Stat
                label="Gross profit today"
                value={formatMoney(profit)}
                tone={profit >= 0 ? 'positive' : 'danger'}
              />
            )}
          </section>
        </>
      )}

      {canSeeStock && (
        <section aria-label="Stock" className="grid gap-4 sm:grid-cols-3">
          <Stat label="Products" value={Number(stock?.products ?? 0).toLocaleString('en-GH')} />
          <Stat
            label="Low stock"
            value={Number(stock?.low_stock ?? 0).toLocaleString('en-GH')}
            tone={Number(stock?.low_stock ?? 0) > 0 ? 'warning' : 'neutral'}
          />
          <Stat
            label="Out of stock"
            value={Number(stock?.out_of_stock ?? 0).toLocaleString('en-GH')}
            tone={Number(stock?.out_of_stock ?? 0) > 0 ? 'danger' : 'neutral'}
          />
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {canSeeStock && (
          <Card>
            <CardHeader
              title="Low stock"
              description="At or below the reorder level"
              action={
                <Link href="/inventory" className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
                  View all
                </Link>
              }
            />
            <CardBody className="p-0">
              {low.length === 0 ? (
                <EmptyState
                  title="Nothing to reorder"
                  description="Every tracked product is above its reorder level."
                />
              ) : (
                <ul className="divide-y divide-[color:var(--color-border)]">
                  {low.map((item) => (
                    <li
                      key={`${item.product_id}-${item.branch_id}`}
                      className="flex items-center justify-between px-5 py-3 text-sm"
                    >
                      <span>
                        <span className="font-medium">{item.name}</span>
                        {item.sku && (
                          <span className="ml-2 text-xs text-[color:var(--color-ink-muted)]">
                            {item.sku}
                          </span>
                        )}
                      </span>
                      <span
                        className={
                          Number(item.quantity) <= 0
                            ? 'text-[color:var(--color-danger)]'
                            : 'text-[color:var(--color-warning)]'
                        }
                      >
                        {Number(item.quantity).toLocaleString('en-GH')} left
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        )}

        {canSeeSales && (
          <Card>
            <CardHeader
              title="Recent sales"
              action={
                <Link href="/sales" className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
                  View all
                </Link>
              }
            />
            <CardBody className="p-0">
              {recent.length === 0 ? (
                <EmptyState
                  title="No sales yet"
                  description="Completed sales appear here as they happen."
                />
              ) : (
                <ul className="divide-y divide-[color:var(--color-border)]">
                  {recent.map((sale) => (
                    <li
                      key={sale.id}
                      className="flex items-center justify-between px-5 py-3 text-sm"
                    >
                      <Link
                        href={`/sales/${sale.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {sale.sale_number}
                      </Link>
                      <span className="text-[color:var(--color-ink-muted)]">
                        {new Date(sale.sold_at).toLocaleString('en-GH', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </span>
                      <span className={sale.status === 'VOIDED' ? 'line-through' : 'font-medium'}>
                        {formatMoney(Number(sale.total))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        )}

        {canSetUpTerminals && slug && (
          <Card>
            <CardHeader
              title="Set up a POS computer"
              description="Install your business application on each till"
            />
            <CardBody className="space-y-3 text-sm">
              <ol className="list-decimal space-y-1.5 pl-5 text-[color:var(--color-ink-muted)]">
                <li>
                  On the POS computer, open{' '}
                  <span className="font-medium text-[color:var(--color-ink)]">
                    {clientAppUrl()}/{slug}
                  </span>{' '}
                  in Edge or Chrome.
                </li>
                <li>Choose Install when prompted, then open Carl from its own window.</li>
                <li>Staff sign in there with their own PIN.</li>
              </ol>
              {windows?.url ? (
                <a
                  href={windows.url}
                  className={buttonClasses({ variant: 'secondary', size: 'sm' })}
                >
                  Download the Windows desktop app
                </a>
              ) : (
                <p className="text-xs text-[color:var(--color-ink-muted)]">
                  For offline selling with a receipt printer, add the till under{' '}
                  <Link href="/devices" className="underline underline-offset-4">
                    Terminals
                  </Link>
                  .
                </p>
              )}
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}
