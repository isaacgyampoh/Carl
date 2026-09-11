import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Permission } from '@carl/domain';
import { hasPermission } from '@carl/application';
import { formatQuantity } from '@carl/shared';
import { Badge, Card, CardHeader, Table, TBody, TD, TH, THead, TR, statusTone } from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';
import { TransferActions } from './transfer-actions';

export const metadata: Metadata = { title: 'Transfer' };
export const dynamic = 'force-dynamic';

interface TransferDetail {
  id: string;
  reference: string;
  status: string;
  notes: string | null;
  created_at: string;
  dispatched_at: string | null;
  received_at: string | null;
  cancel_reason: string | null;
  from_branch_id: string;
  to_branch_id: string;
  from_branch: { name: string } | null;
  to_branch: { name: string } | null;
  stock_transfer_items: {
    id: string;
    quantity_requested: number;
    quantity_sent: number | null;
    quantity_received: number | null;
    products: { id: string; name: string; sku: string } | null;
  }[];
}

export default async function TransferDetailPage({
  params,
}: {
  params: Promise<{ transferId: string }>;
}) {
  const auth = await requirePermission(Permission.INVENTORY_VIEW);
  const { transferId } = await params;

  const client = await supabase();
  const { data: transfer } = await client
    .from('stock_transfers')
    .select(
      `id, reference, status, notes, created_at, dispatched_at, received_at, cancel_reason,
       from_branch_id, to_branch_id,
       from_branch:branches!stock_transfers_from_branch_id_fkey(name),
       to_branch:branches!stock_transfers_to_branch_id_fkey(name),
       stock_transfer_items(id, quantity_requested, quantity_sent, quantity_received,
                            products(id, name, sku))`,
    )
    .eq('tenant_id', auth.tenant.tenantId)
    .eq('id', transferId)
    .maybeSingle<TransferDetail>();

  if (!transfer) notFound();

  // Dispatch is authority over the source; receipt is authority over the destination.
  // The database checks the same thing, so this only decides what is offered.
  const canDispatch =
    hasPermission(auth, Permission.INVENTORY_TRANSFER_APPROVE) &&
    auth.tenant.branches.some((b) => b.id === transfer.from_branch_id);
  const canReceive =
    hasPermission(auth, Permission.INVENTORY_TRANSFER_RECEIVE) &&
    auth.tenant.branches.some((b) => b.id === transfer.to_branch_id);

  return (
    <>
      <PageHeader
        title={transfer.reference}
        description={`${transfer.from_branch?.name ?? ''} → ${transfer.to_branch?.name ?? ''}`}
        action={
          <Badge tone={statusTone(transfer.status)}>
            {transfer.status.replace(/_/g, ' ').toLowerCase()}
          </Badge>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <Card className="overflow-hidden">
          <CardHeader title="Products" />
          <Table>
            <THead>
              <TR>
                <TH>Product</TH>
                <TH numeric>Requested</TH>
                <TH numeric>Sent</TH>
                <TH numeric>Received</TH>
              </TR>
            </THead>
            <TBody>
              {transfer.stock_transfer_items.map((item) => {
                // A shortfall between sent and received is loss in transit, and is shown
                // rather than quietly reconciled.
                const short =
                  item.quantity_sent !== null &&
                  item.quantity_received !== null &&
                  item.quantity_received < item.quantity_sent;

                return (
                  <TR key={item.id}>
                    <TD>
                      <span className="font-medium">{item.products?.name}</span>
                      <span className="block text-xs text-[color:var(--color-ink-muted)]">
                        {item.products?.sku}
                      </span>
                    </TD>
                    <TD numeric>{formatQuantity(Math.round(item.quantity_requested * 1000))}</TD>
                    <TD numeric className="text-[color:var(--color-ink-muted)]">
                      {item.quantity_sent === null
                        ? '—'
                        : formatQuantity(Math.round(item.quantity_sent * 1000))}
                    </TD>
                    <TD numeric>
                      {item.quantity_received === null ? (
                        '—'
                      ) : (
                        <span className={short ? 'text-[color:var(--color-warning)]' : undefined}>
                          {formatQuantity(Math.round(item.quantity_received * 1000))}
                        </span>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </Card>

        <div className="flex flex-col gap-5">
          <TransferActions
            transferId={transfer.id}
            status={transfer.status}
            canDispatch={canDispatch}
            canReceive={canReceive}
            lines={transfer.stock_transfer_items.map((item) => ({
              productId: item.products?.id ?? '',
              name: item.products?.name ?? '',
              sent: item.quantity_sent ?? item.quantity_requested,
            }))}
          />

          <Card>
            <CardHeader title="History" />
            <dl className="space-y-2 px-5 py-4 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-[color:var(--color-ink-muted)]">Created</dt>
                <dd>{new Date(transfer.created_at).toLocaleString('en-GH')}</dd>
              </div>
              {transfer.dispatched_at && (
                <div className="flex justify-between gap-4">
                  <dt className="text-[color:var(--color-ink-muted)]">Dispatched</dt>
                  <dd>{new Date(transfer.dispatched_at).toLocaleString('en-GH')}</dd>
                </div>
              )}
              {transfer.received_at && (
                <div className="flex justify-between gap-4">
                  <dt className="text-[color:var(--color-ink-muted)]">Received</dt>
                  <dd>{new Date(transfer.received_at).toLocaleString('en-GH')}</dd>
                </div>
              )}
              {transfer.cancel_reason && (
                <div className="pt-2">
                  <dt className="text-[color:var(--color-ink-muted)]">Cancelled because</dt>
                  <dd className="mt-1">{transfer.cancel_reason}</dd>
                </div>
              )}
              {transfer.notes && (
                <div className="pt-2">
                  <dt className="text-[color:var(--color-ink-muted)]">Notes</dt>
                  <dd className="mt-1">{transfer.notes}</dd>
                </div>
              )}
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}
