import type { Metadata } from 'next';
import Link from 'next/link';
import { Permission } from '@carl/domain';
import { hasPermission } from '@carl/application';
import { formatMoney } from '@carl/shared';
import {
  Badge,
  Card,
  EmptyState,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  buttonClasses,
  statusTone,
} from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { pageParams, toPage } from '@/server/queries';

export const metadata: Metadata = { title: 'Purchases' };
export const dynamic = 'force-dynamic';

interface PurchaseRow {
  id: string;
  reference: string;
  status: string;
  payment_status: string;
  total: number;
  ordered_at: string | null;
  received_at: string | null;
  suppliers: { name: string } | null;
  branches: { name: string } | null;
}

export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const auth = await requirePermission(Permission.PURCHASES_VIEW);
  const params = await searchParams;
  const { page, pageSize, from, to } = pageParams(params);

  const client = await supabase();
  const { data, count } = await client
    .from('purchases')
    .select(
      'id, reference, status, payment_status, total, ordered_at, received_at, suppliers(name), branches(name)',
      { count: 'exact' },
    )
    .order('created_at', { ascending: false })
    .range(from, to)
    .returns<PurchaseRow[]>();

  const purchases = toPage(data, count, page, pageSize);

  return (
    <>
      <PageHeader
        title="Purchases"
        description="Ordering is not receiving. Stock moves when the goods arrive, not when the order is placed."
        action={
          hasPermission(auth, Permission.PURCHASES_CREATE) ? (
            <Link href="/purchases/new" className={buttonClasses()}>
              New purchase
            </Link>
          ) : null
        }
      />

      <Card className="overflow-hidden">
        {purchases.rows.length === 0 ? (
          <EmptyState
            title="No purchases yet"
            description="Record a purchase to bring stock in and keep cost prices accurate."
            action={
              hasPermission(auth, Permission.PURCHASES_CREATE) ? (
                <Link href="/purchases/new" className={buttonClasses()}>
                  New purchase
                </Link>
              ) : null
            }
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Reference</TH>
                  <TH>Supplier</TH>
                  <TH>Branch</TH>
                  <TH numeric>Total</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {purchases.rows.map((purchase) => (
                  <TR key={purchase.id}>
                    <TD>
                      <Link
                        href={`/purchases/${purchase.id}`}
                        className="font-mono text-sm font-medium hover:text-[color:var(--color-brand)]"
                      >
                        {purchase.reference}
                      </Link>
                      {purchase.ordered_at && (
                        <span className="block text-xs text-[color:var(--color-ink-muted)]">
                          {new Date(purchase.ordered_at).toLocaleDateString('en-GH')}
                        </span>
                      )}
                    </TD>
                    <TD>{purchase.suppliers?.name ?? '—'}</TD>
                    <TD className="text-[color:var(--color-ink-muted)]">
                      {purchase.branches?.name ?? '—'}
                    </TD>
                    <TD numeric>{formatMoney(purchase.total)}</TD>
                    <TD>
                      <Badge tone={statusTone(purchase.status)}>
                        {purchase.status.replace(/_/g, ' ').toLowerCase()}
                      </Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination
              page={purchases.page}
              pageCount={purchases.pageCount}
              total={purchases.total}
              basePath="/purchases"
              searchParams={params}
            />
          </>
        )}
      </Card>
    </>
  );
}
