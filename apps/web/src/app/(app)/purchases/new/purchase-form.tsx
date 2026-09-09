'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, CardHeader } from '@carl/ui';

import { createPurchase } from '@/server/purchasing-actions';
import {
  FormError,
  FormRow,
  FormSection,
  LabelledField,
  inputClass,
  textareaClass,
} from '@/components/form';
import {
  LineItemBuilder,
  type BuilderLine,
  type ProductOption,
} from '@/components/line-item-builder';

/**
 * Creating a purchase order.
 *
 * Placing an order does not move stock — that happens when the goods arrive and someone
 * receives them. Keeping the two apart is what stops a shop reporting stock it has ordered
 * but does not yet have.
 */
export function PurchaseForm({
  branchId,
  branchName,
  suppliers,
  products,
}: {
  branchId: string;
  branchName: string;
  suppliers: { id: string; name: string }[];
  products: ProductOption[];
}) {
  const router = useRouter();
  const [lines, setLines] = useState<BuilderLine[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await createPurchase({
      branchId,
      ...(supplierId ? { supplierId } : {}),
      ...(invoiceNo.trim() ? { supplierInvoiceNo: invoiceNo.trim() } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      items: lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        unitCost: line.unitCost ?? 0,
      })),
    });

    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.push(`/purchases/${result.data.purchaseId}`);
    router.refresh();
  }

  const valid = lines.length > 0 && lines.every((line) => line.quantity > 0);

  return (
    <Card>
      <CardHeader
        title="New purchase"
        description={`Ordering into ${branchName}. Stock moves when you receive the delivery.`}
      />
      <FormError message={error} />

      <FormSection title="Supplier">
        <LabelledField label="Supplier" htmlFor="supplier">
          <select
            id="supplier"
            className={inputClass}
            value={supplierId}
            onChange={(event) => setSupplierId(event.target.value)}
          >
            <option value="">Not specified</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </select>
        </LabelledField>

        <LabelledField
          label="Supplier invoice number"
          htmlFor="invoiceNo"
          hint="Optional. Helps reconcile against the supplier's paperwork."
        >
          <input
            id="invoiceNo"
            className={inputClass}
            value={invoiceNo}
            onChange={(event) => setInvoiceNo(event.target.value)}
          />
        </LabelledField>

        <FormRow wide>
          <LabelledField label="Notes" htmlFor="notes">
            <textarea
              id="notes"
              className={textareaClass}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </LabelledField>
        </FormRow>
      </FormSection>

      <section className="border-b border-[color:var(--color-border)] px-5 py-5">
        <div className="mb-4">
          <h2 className="text-sm font-semibold">Products</h2>
          <p className="mt-0.5 text-sm text-[color:var(--color-ink-muted)]">
            Costs default to the current average and can be adjusted to what the supplier is
            actually charging.
          </p>
        </div>
        <LineItemBuilder products={products} lines={lines} onChange={setLines} withCost />
      </section>

      <div className="flex justify-end gap-2 px-5 py-4">
        <Button type="button" variant="secondary" onClick={() => router.back()} disabled={busy}>
          Cancel
        </Button>
        <Button loading={busy} disabled={!valid} onClick={() => void submit()}>
          Create purchase
        </Button>
      </div>
    </Card>
  );
}
