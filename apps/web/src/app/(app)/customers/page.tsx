import type { Metadata } from 'next';
import { Permission } from '@carl/domain';
import { hasPermission } from '@carl/application';
import { formatMoney } from '@carl/shared';
import Link from 'next/link';
import { Badge, Card, EmptyState, Table, TBody, TD, TH, THead, TR, buttonClasses } from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { ilikeAny, searchTerm } from '@/lib/search';
import { supabase } from '@/lib/supabase';
import { ListSearch } from '@/components/list-search';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { pageParams, toPage } from '@/server/queries';

export const metadata: Metadata = { title: 'Customers' };
export const dynamic = 'force-dynamic';

interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  default_tier: string;
  balance: number;
  is_active: boolean;
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const auth = await requirePermission(Permission.CUSTOMERS_VIEW);
  const params = await searchParams;
  const { page, pageSize, from, to } = pageParams(params);
  const search = searchTerm(params.q);

  const client = await supabase();
  let query = client
    .from('customers')
    .select('id, name, phone, email, default_tier, balance, is_active', { count: 'exact' })
    .eq('tenant_id', auth.tenant.tenantId)
    .order('name')
    .range(from, to);
  if (search) query = query.or(ilikeAny(['name', 'phone', 'email'], search));
  const { data, count } = await query.returns<CustomerRow[]>();

  const customers = toPage(data, count, page, pageSize);

  return (
    <>
      <PageHeader
        title="Customers"
        description="Customers a cashier can attach to a sale. A walk-in needs no record."
        action={
          hasPermission(auth, Permission.CUSTOMERS_CREATE) ? (
            <Link href="/customers/new" className={buttonClasses()}>
              Add customer
            </Link>
          ) : null
        }
      />

      <div className="mb-4">
        <ListSearch
          initialQuery={search ?? ''}
          placeholder="Search by name, phone or email"
          label="Search customers"
        />
      </div>

      <Card className="overflow-hidden">
        {customers.rows.length === 0 ? (
          <EmptyState
            title={search ? `Nothing matches “${search}”` : 'No customers recorded'}
            description={
              hasPermission(auth, Permission.CUSTOMERS_CREATE)
                ? 'Cashiers can add a customer at the till while taking a sale.'
                : 'Customers appear here once they are added.'
            }
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Phone</TH>
                  <TH>Buys at</TH>
                  <TH numeric>Balance</TH>
                </TR>
              </THead>
              <TBody>
                {customers.rows.map((customer) => (
                  <TR key={customer.id}>
                    <TD>
                      <Link
                        href={`/customers/${customer.id}`}
                        className="font-medium hover:text-[color:var(--color-brand)]"
                      >
                        {customer.name}
                      </Link>
                      {!customer.is_active && (
                        <Badge tone="neutral" className="ml-2">
                          Inactive
                        </Badge>
                      )}
                    </TD>
                    <TD className="tabular-nums text-[color:var(--color-ink-muted)]">
                      {customer.phone ?? '—'}
                    </TD>
                    <TD>
                      <Badge tone={customer.default_tier === 'WHOLESALE' ? 'brand' : 'neutral'}>
                        {customer.default_tier.toLowerCase()}
                      </Badge>
                    </TD>
                    <TD numeric>
                      {customer.balance === 0 ? (
                        '—'
                      ) : (
                        <span className="text-[color:var(--color-warning)]">
                          {formatMoney(customer.balance)} owing
                        </span>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination
              page={customers.page}
              pageCount={customers.pageCount}
              total={customers.total}
              basePath="/customers"
              searchParams={params}
            />
          </>
        )}
      </Card>
    </>
  );
}
