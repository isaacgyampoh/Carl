import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Permission } from '@carl/domain';
import { hasPermission } from '@carl/application';
import { formatMoney } from '@carl/shared';
import { Card, CardHeader, EmptyState, Table, TBody, TD, TH, THead, TR } from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';
import { CustomerForm } from '../customer-form';

export const metadata: Metadata = { title: 'Customer' };
export const dynamic = 'force-dynamic';

interface CustomerDetail {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  default_tier: 'RETAIL' | 'WHOLESALE';
  credit_limit: number;
  balance: number;
}

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const auth = await requirePermission(Permission.CUSTOMERS_VIEW);
  const { customerId } = await params;

  const client = await supabase();
  const [{ data: customer }, { data: history }] = await Promise.all([
    client
      .from('customers')
      .select('id, name, phone, email, address, notes, default_tier, credit_limit, balance')
      .eq('id', customerId)
      .maybeSingle<CustomerDetail>(),
    // Purchase history. RLS decides which sales this caller may see, so a cashier sees
    // only their own and a supervisor sees the branch's.
    client
      .from('sales')
      .select('id, sale_number, total, sold_at, status')
      .eq('customer_id', customerId)
      .order('sold_at', { ascending: false })
      .limit(20),
  ]);

  if (!customer) notFound();

  return (
    <>
      <PageHeader title={customer.name} description={customer.phone ?? undefined} />

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-5">
          {hasPermission(auth, Permission.CUSTOMERS_UPDATE) ? (
            <CustomerForm
              customerId={customer.id}
              initial={{
                name: customer.name,
                phone: customer.phone,
                email: customer.email,
                address: customer.address,
                notes: customer.notes,
                defaultTier: customer.default_tier,
                creditLimit: customer.credit_limit,
              }}
            />
          ) : (
            <Card>
              <CardHeader title="Details" />
              <EmptyState
                title="Read only"
                description="You can see this customer but not change their details."
              />
            </Card>
          )}
        </div>

        <Card className="overflow-hidden">
          <CardHeader title="Purchase history" description="Most recent first." />
          {(history ?? []).length === 0 ? (
            <EmptyState title="No purchases yet" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Receipt</TH>
                  <TH numeric>Total</TH>
                </TR>
              </THead>
              <TBody>
                {(history ?? []).map((sale) => (
                  <TR key={sale.id}>
                    <TD>
                      <span className="font-mono text-xs">{sale.sale_number}</span>
                      <span className="block text-xs text-[color:var(--color-ink-muted)]">
                        {new Date(sale.sold_at).toLocaleDateString('en-GH')}
                      </span>
                    </TD>
                    <TD numeric>{formatMoney(sale.total)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
