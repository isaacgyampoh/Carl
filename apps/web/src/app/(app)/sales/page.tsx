import type { Metadata } from 'next';
import Link from 'next/link';
import { Permission } from '@carl/domain';
import { formatMoney } from '@carl/shared';
import { Badge, Card, EmptyState, Table, TBody, TD, TH, THead, TR, statusTone } from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { pageParams, toPage } from '@/server/queries';

export const metadata: Metadata = { title: 'Sales' };
export const dynamic = 'force-dynamic';

interface SaleRow {
  id: string;
  sale_number: string;
  status: string;
  total: number;
  amount_refunded: number;
  sold_at: string;
  is_offline_sale: boolean;
  customers: { name: string } | null;
  profiles: { full_name: string } | null;
}

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const auth = await requirePermission(Permission.SALES_VIEW);
  const params = await searchParams;
  const { page, pageSize, from, to } = pageParams(params);

  const client = await supabase();

  // RLS decides which sales are visible: sales.view shows your own, sales.view_all shows
  // the branch's. The tenant filter is not the control either; it keeps someone who works
  // for two businesses looking at the one they chose.
  const { data, count } = await client
    .from('sales')
    .select(
      `id, sale_number, status, total, amount_refunded, sold_at, is_offline_sale,
       customers(name), profiles!sales_cashier_id_fkey(full_name)`,
      { count: 'exact' },
    )
    .eq('tenant_id', auth.tenant.tenantId)
    .order('sold_at', { ascending: false })
    .range(from, to)
    .returns<SaleRow[]>();

  const sales = toPage(data, count, page, pageSize);

  return (
    <>
      <PageHeader
        title="Sales"
        description="Newest first. A sale is never deleted — it is voided or returned, and both are recorded."
      />

      <Card className="overflow-hidden">
        {sales.rows.length === 0 ? (
          <EmptyState
            title="No sales yet"
            description="Completed sales appear here as soon as they are taken."
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Receipt</TH>
                  <TH>When</TH>
                  <TH>Cashier</TH>
                  <TH>Customer</TH>
                  <TH numeric>Total</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {sales.rows.map((sale) => (
                  <TR key={sale.id}>
                    <TD>
                      <Link
                        href={`/sales/${sale.id}`}
                        className="font-mono text-sm font-medium hover:text-[color:var(--color-brand)]"
                      >
                        {sale.sale_number}
                      </Link>
                      {sale.is_offline_sale && (
                        <Badge tone="neutral" className="ml-2">
                          Offline
                        </Badge>
                      )}
                    </TD>
                    <TD className="text-[color:var(--color-ink-muted)]">
                      {new Date(sale.sold_at).toLocaleString('en-GH', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </TD>
                    <TD>{sale.profiles?.full_name ?? '—'}</TD>
                    <TD className="text-[color:var(--color-ink-muted)]">
                      {sale.customers?.name ?? 'Walk-in'}
                    </TD>
                    <TD numeric>
                      {formatMoney(sale.total)}
                      {sale.amount_refunded > 0 && (
                        <span className="block text-xs text-[color:var(--color-danger)]">
                          −{formatMoney(sale.amount_refunded)} refunded
                        </span>
                      )}
                    </TD>
                    <TD>
                      <Badge tone={statusTone(sale.status)}>
                        {sale.status.replace(/_/g, ' ').toLowerCase()}
                      </Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination
              page={sales.page}
              pageCount={sales.pageCount}
              total={sales.total}
              basePath="/sales"
              searchParams={params}
            />
          </>
        )}
      </Card>
    </>
  );
}
