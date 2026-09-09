import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Permission } from '@carl/domain';
import { hasPermission } from '@carl/application';
import { formatMoney } from '@carl/shared';
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  statusTone,
} from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';
import { SupplierForm } from '../supplier-form';

export const metadata: Metadata = { title: 'Supplier' };
export const dynamic = 'force-dynamic';

interface SupplierDetail {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  payment_terms_days: number;
  balance: number;
}

export default async function SupplierDetailPage({
  params,
}: {
  params: Promise<{ supplierId: string }>;
}) {
  const auth = await requirePermission(Permission.SUPPLIERS_VIEW);
  const { supplierId } = await params;

  const client = await supabase();
  const [{ data: supplier }, { data: purchases }] = await Promise.all([
    client
      .from('suppliers')
      .select('id, name, contact_name, phone, email, address, notes, payment_terms_days, balance')
      .eq('id', supplierId)
      .maybeSingle<SupplierDetail>(),
    client
      .from('purchases')
      .select('id, reference, total, status, ordered_at')
      .eq('supplier_id', supplierId)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  if (!supplier) notFound();

  return (
    <>
      <PageHeader title={supplier.name} description={supplier.contact_name ?? undefined} />

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        {hasPermission(auth, Permission.SUPPLIERS_MANAGE) ? (
          <SupplierForm
            supplierId={supplier.id}
            initial={{
              name: supplier.name,
              contactName: supplier.contact_name,
              phone: supplier.phone,
              email: supplier.email,
              address: supplier.address,
              notes: supplier.notes,
              paymentTermsDays: supplier.payment_terms_days,
            }}
          />
        ) : (
          <Card>
            <CardHeader title="Details" />
            <EmptyState
              title="Read only"
              description="You can see this supplier but not change it."
            />
          </Card>
        )}

        <Card className="overflow-hidden">
          <CardHeader title="Purchase history" />
          {(purchases ?? []).length === 0 ? (
            <EmptyState title="No purchases yet" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Reference</TH>
                  <TH numeric>Total</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {(purchases ?? []).map((purchase) => (
                  <TR key={purchase.id}>
                    <TD className="font-mono text-xs">{purchase.reference}</TD>
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
          )}
        </Card>
      </div>
    </>
  );
}
