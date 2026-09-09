import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Permission } from '@carl/domain';
import { hasPermission } from '@carl/application';
import { formatMoney, formatQuantity } from '@carl/shared';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
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
import { SaleActions } from './sale-actions';

export const metadata: Metadata = { title: 'Sale' };
export const dynamic = 'force-dynamic';

interface SaleDetail {
  id: string;
  sale_number: string;
  status: string;
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  total: number;
  amount_paid: number;
  change_given: number;
  amount_refunded: number;
  sold_at: string;
  note: string | null;
  void_reason: string | null;
  is_offline_sale: boolean;
  branches: { name: string } | null;
  customers: { name: string; phone: string | null } | null;
  profiles: { full_name: string } | null;
  sale_items: {
    id: string;
    line_number: number;
    product_name: string;
    product_sku: string;
    quantity: number;
    unit_price: number;
    discount_amount: number;
    tax_amount: number;
    line_total: number;
    quantity_returned: number;
  }[];
  sale_payments: { id: string; method: string; amount: number; reference: string | null }[];
}

export default async function SaleDetailPage({ params }: { params: Promise<{ saleId: string }> }) {
  const auth = await requirePermission(Permission.SALES_VIEW);
  const { saleId } = await params;

  const client = await supabase();
  const { data: sale } = await client
    .from('sales')
    .select(
      `id, sale_number, status, subtotal, discount_amount, tax_amount, total,
       amount_paid, change_given, amount_refunded, sold_at, note, void_reason, is_offline_sale,
       branches(name), customers(name, phone), profiles!sales_cashier_id_fkey(full_name),
       sale_items(id, line_number, product_name, product_sku, quantity, unit_price,
                  discount_amount, tax_amount, line_total, quantity_returned),
       sale_payments(id, method, amount, reference)`,
    )
    .eq('id', saleId)
    .maybeSingle<SaleDetail>();

  // RLS returns nothing rather than erroring for a sale the caller may not see, so a
  // forbidden sale and a non-existent one are indistinguishable here — which is the
  // intended behaviour: confirming a receipt exists is itself a disclosure.
  if (!sale) notFound();

  const items = [...sale.sale_items].sort((a, b) => a.line_number - b.line_number);
  const returnable = items.filter((item) => item.quantity_returned < item.quantity);

  return (
    <>
      <PageHeader
        title={sale.sale_number}
        description={`${sale.branches?.name ?? ''} · ${new Date(sale.sold_at).toLocaleString(
          'en-GH',
          { dateStyle: 'full', timeStyle: 'short' },
        )}`}
        action={
          <div className="flex items-center gap-2">
            <Badge tone={statusTone(sale.status)}>
              {sale.status.replace(/_/g, ' ').toLowerCase()}
            </Badge>
            <Link href="/sales" className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
              Back to sales
            </Link>
          </div>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-5">
          <Card className="overflow-hidden">
            <CardHeader title="Items" />
            <Table>
              <THead>
                <TR>
                  <TH>Product</TH>
                  <TH numeric>Qty</TH>
                  <TH numeric>Price</TH>
                  <TH numeric>Total</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((item) => (
                  <TR key={item.id}>
                    <TD>
                      {/* The name recorded at the time of sale, not today's. */}
                      <span className="font-medium">{item.product_name}</span>
                      <span className="block text-xs text-[color:var(--color-ink-muted)]">
                        {item.product_sku}
                        {item.quantity_returned > 0 && (
                          <span className="ml-2 text-[color:var(--color-danger)]">
                            {formatQuantity(Math.round(item.quantity_returned * 1000))} returned
                          </span>
                        )}
                      </span>
                    </TD>
                    <TD numeric>{formatQuantity(Math.round(item.quantity * 1000))}</TD>
                    <TD numeric>{formatMoney(item.unit_price)}</TD>
                    <TD numeric>
                      {formatMoney(item.line_total)}
                      {item.discount_amount > 0 && (
                        <span className="block text-xs text-[color:var(--color-ink-muted)]">
                          −{formatMoney(item.discount_amount)}
                        </span>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Payment" />
            <Table>
              <THead>
                <TR>
                  <TH>Method</TH>
                  <TH>Reference</TH>
                  <TH numeric>Amount</TH>
                </TR>
              </THead>
              <TBody>
                {sale.sale_payments.map((payment) => (
                  <TR key={payment.id}>
                    <TD>{payment.method.replace(/_/g, ' ').toLowerCase()}</TD>
                    <TD className="font-mono text-xs text-[color:var(--color-ink-muted)]">
                      {payment.reference ?? '—'}
                    </TD>
                    <TD numeric>{formatMoney(payment.amount)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader title="Totals" />
            <CardBody>
              <dl className="space-y-2 text-sm">
                <Row label="Subtotal" value={formatMoney(sale.subtotal)} />
                {sale.discount_amount > 0 && (
                  <Row label="Discount" value={`−${formatMoney(sale.discount_amount)}`} />
                )}
                {sale.tax_amount > 0 && <Row label="Tax" value={formatMoney(sale.tax_amount)} />}
                <div className="flex justify-between border-t border-[color:var(--color-border)] pt-2 text-base font-semibold">
                  <dt>Total</dt>
                  <dd className="tabular-nums">{formatMoney(sale.total)}</dd>
                </div>
                <Row label="Received" value={formatMoney(sale.amount_paid)} />
                {sale.change_given > 0 && (
                  <Row label="Change" value={formatMoney(sale.change_given)} />
                )}
                {sale.amount_refunded > 0 && (
                  <Row
                    label="Refunded"
                    value={`−${formatMoney(sale.amount_refunded)}`}
                    tone="danger"
                  />
                )}
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <dl className="space-y-2 text-sm">
                <Row label="Cashier" value={sale.profiles?.full_name ?? '—'} />
                <Row label="Customer" value={sale.customers?.name ?? 'Walk-in'} />
                {sale.customers?.phone && <Row label="Phone" value={sale.customers.phone} />}
                {sale.is_offline_sale && <Row label="Recorded" value="Offline, synced later" />}
                {sale.note && <Row label="Note" value={sale.note} />}
                {sale.void_reason && (
                  <Row label="Void reason" value={sale.void_reason} tone="danger" />
                )}
              </dl>
            </CardBody>
          </Card>

          {sale.status !== 'VOIDED' && (
            <SaleActions
              saleId={sale.id}
              items={returnable.map((item) => ({
                id: item.id,
                name: item.product_name,
                available: item.quantity - item.quantity_returned,
                unitPrice: item.unit_price,
              }))}
              canRefund={hasPermission(auth, Permission.SALES_REFUND)}
              canVoid={hasPermission(auth, Permission.SALES_VOID)}
            />
          )}
        </div>
      </div>
    </>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-[color:var(--color-ink-muted)]">{label}</dt>
      <dd
        className={`text-right tabular-nums ${
          tone === 'danger' ? 'text-[color:var(--color-danger)]' : ''
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
