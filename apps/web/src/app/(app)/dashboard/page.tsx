import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { activeBranch, hasPermission } from '@carl/application';
import { Permission } from '@carl/domain';
import { EmptyState } from '@carl/ui';

import { requireAuth } from '@/lib/auth';
import { clientAppUrl } from '@/lib/downloads';
import { supabase } from '@/lib/supabase';
import { DashboardView } from './dashboard-view';

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
 *
 * The page gathers; `DashboardView` presents.
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

  const can = {
    sell: canSell,
    sales: hasPermission(auth, Permission.SALES_VIEW_ALL),
    profit: hasPermission(auth, Permission.REPORTS_VIEW_FINANCIAL),
    stock: hasPermission(auth, Permission.INVENTORY_VIEW),
    addProduct: hasPermission(auth, Permission.PRODUCTS_CREATE),
    adjustStock: hasPermission(auth, Permission.INVENTORY_ADJUST),
    manageStaff: hasPermission(auth, Permission.STAFF_MANAGE),
    reports: canReport,
    recordExpense: hasPermission(auth, Permission.EXPENSES_CREATE),
  };
  const canSetUpTerminals = hasPermission(auth, Permission.DEVICES_MANAGE);
  // The setup checklist is for someone who can act on it.
  const guideSetup = can.addProduct || can.adjustStock || can.manageStaff;

  const tenantId = auth.tenant.tenantId;
  const branch = activeBranch(auth);
  const branchId = branch?.id;
  const scope = { p_tenant_id: tenantId, ...(branchId ? { p_branch_id: branchId } : {}) };
  const client = await supabase();

  const [
    todayResult,
    periodsResult,
    stockResult,
    lowResult,
    recentResult,
    tenantResult,
    setupResults,
  ] = await Promise.all([
    can.sales ? client.rpc('tenant_dashboard_today', scope) : null,
    can.sales ? client.rpc('tenant_sales_periods', scope) : null,
    can.stock ? client.rpc('inventory_overview', scope) : null,
    can.stock ? client.rpc('low_stock_items', { ...scope, p_limit: 8 }) : null,
    can.sales
      ? (() => {
          let query = client
            .from('sales')
            .select('id, sale_number, total, sold_at, status')
            .eq('tenant_id', tenantId)
            .order('sold_at', { ascending: false })
            .limit(6);
          if (branchId) query = query.eq('branch_id', branchId);
          return query.returns<RecentSale[]>();
        })()
      : null,
    canSetUpTerminals
      ? client.from('tenants').select('slug').eq('id', tenantId).maybeSingle()
      : null,
    /*
     * Has this business done each first step? Existence checks (limit 1 or 2), never counts,
     * so a business with a large catalogue pays nothing for a checklist it finished long ago.
     */
    guideSetup
      ? Promise.all([
          client.from('products').select('id').eq('tenant_id', tenantId).limit(1),
          client
            .from('inventory')
            .select('product_id')
            .eq('tenant_id', tenantId)
            .gt('quantity', 0)
            .limit(1),
          client
            .from('tenant_memberships')
            .select('id')
            .eq('tenant_id', tenantId)
            .neq('status', 'REMOVED')
            .limit(2),
          client.from('sales').select('id').eq('tenant_id', tenantId).limit(1),
        ])
      : null,
  ]);

  const today = todayResult?.data?.[0];
  const periods = periodsResult?.data?.[0];
  const stock = stockResult?.data?.[0];
  const slug = tenantResult?.data?.slug ?? null;

  return (
    <DashboardView
      data={{
        tenantName: auth.tenant.tenantName,
        branchName: branch?.name ?? null,
        multiBranch: auth.tenant.branches.length > 1,
        can,
        today: can.sales
          ? {
              gross: Number(today?.gross ?? 0),
              count: Number(today?.sales_count ?? 0),
              cash: Number(today?.cash ?? 0),
              momo: Number(today?.momo ?? 0),
              cost: Number(today?.cost ?? 0),
            }
          : null,
        periods: can.sales
          ? {
              week: {
                gross: Number(periods?.week_gross ?? 0),
                count: Number(periods?.week_count ?? 0),
              },
              month: {
                gross: Number(periods?.month_gross ?? 0),
                count: Number(periods?.month_count ?? 0),
              },
              year: {
                gross: Number(periods?.year_gross ?? 0),
                count: Number(periods?.year_count ?? 0),
              },
            }
          : null,
        stock: can.stock
          ? {
              products: Number(stock?.products ?? 0),
              low: Number(stock?.low_stock ?? 0),
              out: Number(stock?.out_of_stock ?? 0),
            }
          : null,
        low: (lowResult?.data ?? []).map((item) => ({
          key: `${item.product_id}-${item.branch_id}`,
          name: item.name ?? '',
          sku: item.sku ?? null,
          quantity: Number(item.quantity ?? 0),
        })),
        recent: (recentResult?.data ?? []).map((sale) => ({
          id: sale.id,
          number: sale.sale_number,
          total: Number(sale.total),
          soldAt: sale.sold_at,
          status: sale.status,
        })),
        setup: setupResults
          ? {
              products: (setupResults[0].data ?? []).length > 0,
              stock: (setupResults[1].data ?? []).length > 0,
              staff: (setupResults[2].data ?? []).length > 1,
              sale: (setupResults[3].data ?? []).length > 0,
            }
          : null,
        install: canSetUpTerminals && slug ? { url: `${clientAppUrl()}/${slug}` } : null,
      }}
    />
  );
}
