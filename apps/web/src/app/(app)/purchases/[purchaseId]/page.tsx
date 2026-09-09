import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Permission } from '@carl/domain';
import { hasPermission } from '@carl/application';
import { formatMoney, formatQuantity } from '@carl/shared';
import { Badge, Card, CardHeader, Table, TBody, TD, TH, THead, TR, statusTone } from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';
import { ReceivePurchase } from './receive-purchase';

export const metadata: Metadata = { title: 'Purchase' };
export const dynamic = 'force-dynamic';

interface PurchaseDetail {
  id: string;
  reference: string;
  status: string;
  total: number;
  supplier_invoice_no: string | null;
  notes: string | null;
  ordered_at: string | null;
  received_at: string | null;
  suppliers: { name: string } | null;
  branches: { name: string } | null;
  purchase_items: {
    id: string;
    line_number: number;
    quantity_ordered: number;
    quantity_received: number;
    unit_cost: number;
    line_total: number;
    products: { id: string; name: string; sku: string; unit: string } | null;
  }[];
}

export default async function PurchaseDetailPage({
  params,
}: {
  params: Promise<{ purchaseId: string }>;
}) {
  const auth = await requirePermission(Permission.PURCHASES_VIEW);
  const { purchaseId } = await params;

  const client = await supabase();
  const { data: purchase } = await client
    .from('purchases')
    .select(
      `id, reference, status, total, supplier_invoice_no, notes, ordered_at, received_at,
       suppliers(name), branches(name),
       purchase_items(id, line_number, quantity_ordered, quantity_received, unit_cost, line_total,
                      products(id, name, sku, unit))`,
    )
    .eq('id', purchaseId)
    .maybeSingle<PurchaseDetail>();

  if (!purchase) notFound();

  const items = [...purchase.purchase_items].sort((a, b) => a.line_number - b.line_number);
  const outstanding = items.filter((item) => item.quantity_received < item.quantity_ordered);
  const canReceive =
    hasPermission(auth, Permission.PURCHASES_RECEIVE) &&
    purchase.status !== 'CANCELLED' &&
    outstanding.length > 0;

  return (
    <>
      <PageHeader
        title={purchase.reference}
        description={`${purchase.suppliers?.name ?? 'No supplier'} · ${purchase.branches?.name ?? ''}`}
        action={
          <Badge tone={statusTone(purchase.status)}>
            {purchase.status.replace(/_/g, ' ').toLowerCase()}
          </Badge>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <Card className="overflow-hidden">
          <CardHeader
            title="Lines"
            description="Received quantities update stock and the weighted-average cost."
          />
          <Table>
            <THead>
              <TR>
                <TH>Product</TH>
                <TH numeric>Ordered</TH>
                <TH numeric>Received</TH>
                <TH numeric>Unit cost</TH>
                <TH numeric>Total</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((item) => {
                const complete = item.quantity_received >= item.quantity_ordered;
                return (
                  <TR key={item.id}>
                    <TD>
                      <span className="font-medium">{item.products?.name}</span>
                      <span className="block text-xs text-[color:var(--color-ink-muted)]">
                        {item.products?.sku}
                      </span>
                    </TD>
                    <TD numeric>{formatQuantity(Math.round(item.quantity_ordered * 1000))}</TD>
                    <TD numeric>
                      <span
                        className={
                          complete
                            ? 'text-[color:var(--color-positive)]'
                            : item.quantity_received > 0
                              ? 'text-[color:var(--color-warning)]'
                              : 'text-[color:var(--color-ink-muted)]'
                        }
                      >
                        {formatQuantity(Math.round(item.quantity_received * 1000))}
                      </span>
                    </TD>
                    <TD numeric>{formatMoney(item.unit_cost)}</TD>
                    <TD numeric>{formatMoney(item.line_total)}</TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
          <div className="flex justify-between border-t border-[color:var(--color-border)] px-4 py-3">
            <span className="text-sm font-medium text-[color:var(--color-ink-muted)]">Total</span>
            <span className="text-lg font-semibold tabular-nums">
              {formatMoney(purchase.total)}
            </span>
          </div>
        </Card>

        <div className="flex flex-col gap-5">
          {canReceive && (
            <ReceivePurchase
              purchaseId={purchase.id}
              lines={outstanding.map((item) => ({
                productId: item.products?.id ?? '',
                name: item.products?.name ?? '',
                outstanding: item.quantity_ordered - item.quantity_received,
                unitCost: item.unit_cost,
              }))}
            />
          )}

          <Card>
            <CardHeader title="Details" />
            <dl className="space-y-2 px-5 py-4 text-sm">
              {purchase.supplier_invoice_no && (
                <div className="flex justify-between gap-4">
                  <dt className="text-[color:var(--color-ink-muted)]">Supplier invoice</dt>
                  <dd className="font-mono text-xs">{purchase.supplier_invoice_no}</dd>
                </div>
              )}
              {purchase.ordered_at && (
                <div className="flex justify-between gap-4">
                  <dt className="text-[color:var(--color-ink-muted)]">Ordered</dt>
                  <dd>{new Date(purchase.ordered_at).toLocaleDateString('en-GH')}</dd>
                </div>
              )}
              {purchase.received_at && (
                <div className="flex justify-between gap-4">
                  <dt className="text-[color:var(--color-ink-muted)]">First received</dt>
                  <dd>{new Date(purchase.received_at).toLocaleDateString('en-GH')}</dd>
                </div>
              )}
              {purchase.notes && (
                <div className="pt-2">
                  <dt className="text-[color:var(--color-ink-muted)]">Notes</dt>
                  <dd className="mt-1">{purchase.notes}</dd>
                </div>
              )}
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}
