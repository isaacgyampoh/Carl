import { NextResponse } from 'next/server';
import { hasPermission } from '@carl/application';
import { Permission } from '@carl/domain';

import { currentAuth } from '@/lib/auth';
import { csvFilename, csvMoney, toCsv, type CsvColumn } from '@/lib/csv';
import { supabase } from '@/lib/supabase';
import { resolveRange } from '../range-picker';

export const dynamic = 'force-dynamic';

/**
 * The figures on the reports page, as a file an accountant can open.
 *
 * Every shop that keeps books outside Carl was retyping totals off a screen. This hands them
 * the same numbers the page shows, over the same range, for the same branch.
 *
 * It is not a second way to read data: the query runs as the caller, so Row Level Security
 * returns exactly the rows their session may see, and the permission the reports page requires
 * is required here too. A caller who edits the query string gets their own data or nothing.
 */
const KINDS = ['sales', 'payments', 'staff', 'products'] as const;
type Kind = (typeof KINDS)[number];

interface SaleRow {
  sale_number: string;
  sold_at: string;
  status: string;
  total: number;
  amount_paid: number;
  change_given: number;
  branches: { name: string } | null;
  profiles: { full_name: string } | null;
  customers: { name: string } | null;
}

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await currentAuth();
  if (!auth?.tenant) return new NextResponse('Not found', { status: 404 });
  if (!hasPermission(auth, Permission.REPORTS_VIEW)) {
    return new NextResponse('Not found', { status: 404 });
  }

  const params = new URL(request.url).searchParams;
  const requested = params.get('type') ?? '';
  const kind: Kind = (KINDS as readonly string[]).includes(requested)
    ? (requested as Kind)
    : 'sales';
  const { from, to } = resolveRange(
    params.get('range') ?? undefined,
    params.get('from') ?? undefined,
    params.get('to') ?? undefined,
  );
  // A branch the caller cannot reach selects nothing, because it is matched against their own.
  const wantedBranch = params.get('branch');
  const branchId =
    wantedBranch && auth.tenant.branches.some((branch) => branch.id === wantedBranch)
      ? wantedBranch
      : null;

  const client = await supabase();
  const args = {
    p_tenant_id: auth.tenant.tenantId,
    p_from: from,
    p_to: to,
    ...(branchId ? { p_branch_id: branchId } : {}),
  };

  let csv: string;
  if (kind === 'sales') {
    let query = client
      .from('sales')
      .select(
        'sale_number, sold_at, status, total, amount_paid, change_given, branches(name), profiles!sales_cashier_id_fkey(full_name), customers(name)',
      )
      .gte('sold_at', from)
      .lt('sold_at', to)
      .order('sold_at', { ascending: true })
      // Enough for a month of a busy shop; beyond that a narrower range is the right answer.
      .limit(10_000);
    if (branchId) query = query.eq('branch_id', branchId);
    const { data } = await query.returns<SaleRow[]>();
    const columns: CsvColumn<SaleRow>[] = [
      { header: 'Receipt', value: (row) => row.sale_number },
      { header: 'Sold at', value: (row) => row.sold_at },
      { header: 'Branch', value: (row) => row.branches?.name ?? '' },
      { header: 'Cashier', value: (row) => row.profiles?.full_name ?? '' },
      { header: 'Customer', value: (row) => row.customers?.name ?? 'Walk-in' },
      { header: 'Status', value: (row) => row.status },
      { header: 'Total', value: (row) => csvMoney(row.total) },
      { header: 'Paid', value: (row) => csvMoney(row.amount_paid) },
      { header: 'Change', value: (row) => csvMoney(row.change_given) },
    ];
    csv = toCsv(data ?? [], columns);
  } else if (kind === 'payments') {
    const { data } = await client.rpc('payment_method_breakdown', args);
    const rows = data ?? [];
    csv = toCsv(rows, [
      { header: 'Method', value: (row) => row.method ?? '' },
      { header: 'Transactions', value: (row) => row.payment_count ?? 0 },
      { header: 'Amount', value: (row) => csvMoney(row.amount) },
    ]);
  } else if (kind === 'staff') {
    const { data } = await client.rpc('staff_sales_summary', args);
    const rows = data ?? [];
    csv = toCsv(rows, [
      { header: 'Person', value: (row) => row.cashier_name ?? '' },
      { header: 'Transactions', value: (row) => row.sales_count ?? 0 },
      { header: 'Sales', value: (row) => csvMoney(row.gross) },
      { header: 'Refunds', value: (row) => csvMoney(row.refunds) },
    ]);
  } else {
    const { data } = await client.rpc('top_products', { ...args, p_limit: 500 });
    const rows = data ?? [];
    csv = toCsv(rows, [
      { header: 'Product', value: (row) => row.product_name ?? '' },
      { header: 'Sold', value: (row) => row.quantity_sold ?? 0 },
      { header: 'Sales', value: (row) => csvMoney(row.revenue) },
      { header: 'Profit', value: (row) => csvMoney(row.profit) },
    ]);
  }

  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${csvFilename(kind, from, to)}"`,
      // A shop's takings do not belong in any cache between here and their laptop.
      'cache-control': 'no-store',
    },
  });
}
