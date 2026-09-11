import type { Metadata } from 'next';
import { Permission } from '@carl/domain';
import { formatMoney } from '@carl/shared';
import Link from 'next/link';
import { hasPermission } from '@carl/application';
import { Badge, Card, EmptyState, Table, TBody, TD, TH, THead, TR, buttonClasses } from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { pageParams, toPage } from '@/server/queries';

export const metadata: Metadata = { title: 'Suppliers' };
export const dynamic = 'force-dynamic';

interface SupplierRow {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  payment_terms_days: number;
  balance: number;
  is_active: boolean;
}

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const auth = await requirePermission(Permission.SUPPLIERS_VIEW);
  const params = await searchParams;
  const { page, pageSize, from, to } = pageParams(params);

  const client = await supabase();
  const { data, count } = await client
    .from('suppliers')
    .select('id, name, contact_name, phone, payment_terms_days, balance, is_active', {
      count: 'exact',
    })
    .eq('tenant_id', auth.tenant.tenantId)
    .order('name')
    .range(from, to)
    .returns<SupplierRow[]>();

  const suppliers = toPage(data, count, page, pageSize);

  return (
    <>
      <PageHeader
        title="Suppliers"
        description="Who the business buys from, and what it owes."
        action={
          hasPermission(auth, Permission.SUPPLIERS_MANAGE) ? (
            <Link href="/suppliers/new" className={buttonClasses()}>
              Add supplier
            </Link>
          ) : null
        }
      />

      <Card className="overflow-hidden">
        {suppliers.rows.length === 0 ? (
          <EmptyState
            title="No suppliers recorded"
            description="Add a supplier before recording a purchase."
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Supplier</TH>
                  <TH>Contact</TH>
                  <TH>Terms</TH>
                  <TH numeric>Owed</TH>
                </TR>
              </THead>
              <TBody>
                {suppliers.rows.map((supplier) => (
                  <TR key={supplier.id}>
                    <TD>
                      <Link
                        href={`/suppliers/${supplier.id}`}
                        className="font-medium hover:text-[color:var(--color-brand)]"
                      >
                        {supplier.name}
                      </Link>
                      {!supplier.is_active && (
                        <Badge tone="neutral" className="ml-2">
                          Inactive
                        </Badge>
                      )}
                    </TD>
                    <TD className="text-[color:var(--color-ink-muted)]">
                      {supplier.contact_name ?? '—'}
                      {supplier.phone && (
                        <span className="block text-xs tabular-nums">{supplier.phone}</span>
                      )}
                    </TD>
                    <TD className="text-[color:var(--color-ink-muted)]">
                      {supplier.payment_terms_days > 0
                        ? `${supplier.payment_terms_days} days`
                        : 'On delivery'}
                    </TD>
                    <TD numeric>
                      {supplier.balance === 0 ? (
                        '—'
                      ) : (
                        <span className="text-[color:var(--color-warning)]">
                          {formatMoney(supplier.balance)}
                        </span>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination
              page={suppliers.page}
              pageCount={suppliers.pageCount}
              total={suppliers.total}
              basePath="/suppliers"
              searchParams={params}
            />
          </>
        )}
      </Card>
    </>
  );
}
