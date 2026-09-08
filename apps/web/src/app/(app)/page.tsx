import type { Metadata } from 'next';
import Link from 'next/link';
import { formatMoney } from '@carl/shared';
import { Card, CardBody, CardHeader, EmptyState, Stat, buttonClasses } from '@carl/ui';
import { Permission } from '@carl/domain';
import { hasPermission } from '@carl/application';

import { requireAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

export const metadata: Metadata = { title: 'Dashboard' };

// Money and stock change constantly; a cached dashboard shows a shop yesterday's takings.
export const dynamic = 'force-dynamic';

/**
 * The tenant dashboard.
 *
 * Every figure is computed in PostgreSQL over the branch's own rows. Nothing is summed in
 * React — a shop with a year of sales would otherwise ship tens of thousands of rows to a
 * phone to display six numbers.
 */
export default async function DashboardPage() {
  const auth = await requireAuth();

  if (!auth.tenant) {
    return (
      <EmptyState
        title="No business attached to your account"
        description="Your account exists but is not yet part of a business. Contact whoever manages Carl for your organisation."
      />
    );
  }

  const branchId = auth.tenant.activeBranchId;
  const client = await supabase();
  const canSeeMoney = hasPermission(auth, Permission.REPORTS_VIEW_FINANCIAL);

  // RLS confines this to branches the caller may reach, so a missing branch filter would
  // widen the figure to their own accessible branches — never to another tenant.
  const { data: totals } = await client.rpc('tenant_dashboard_today', {
    p_tenant_id: auth.tenant.tenantId,
    p_branch_id: branchId ?? undefined,
  });

  const row = totals?.[0];
  const today = {
    salesCount: row?.sales_count ?? 0,
    gross: row?.gross ?? 0,
    cost: row?.cost ?? 0,
    cash: row?.cash ?? 0,
  };
  const profit = today.gross - today.cost;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{auth.tenant.tenantName}</h1>
          <p className="mt-0.5 text-sm text-[color:var(--color-ink-muted)]">
            Today at a glance{auth.tenant.branches.length > 1 ? ', for the selected branch' : ''}.
          </p>
        </div>
        {hasPermission(auth, Permission.SALES_CREATE) && (
          <Link href="/pos" className={buttonClasses({ size: 'lg' })}>
            Open point of sale
          </Link>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Sales today" value={formatMoney(today.gross)} />
        <Stat label="Transactions" value={today.salesCount.toLocaleString('en-GH')} />
        {canSeeMoney && (
          <Stat
            label="Gross profit"
            value={formatMoney(profit)}
            tone={profit >= 0 ? 'positive' : 'danger'}
          />
        )}
        <Stat label="Cash taken" value={formatMoney(today.cash)} hint="Excludes mobile money" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Low stock"
            description="Products at or below their reorder level"
            action={
              <Link href="/inventory" className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
                View all
              </Link>
            }
          />
          <CardBody className="p-0">
            <EmptyState
              title="Nothing to reorder"
              description="Low-stock alerts appear here once products and stock levels are recorded."
            />
          </CardBody>
        </Card>

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
            <EmptyState
              title="No sales yet today"
              description="Completed sales appear here as they happen."
            />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
