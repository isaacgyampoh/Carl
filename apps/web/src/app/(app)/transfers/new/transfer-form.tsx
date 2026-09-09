'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Card, CardHeader } from '@carl/ui';

import { createTransfer } from '@/server/purchasing-actions';
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
 * Creating a stock transfer.
 *
 * The source branch list contains only branches this user may act in — but that is a
 * convenience, not the control. `create_stock_transfer` checks authority over the source
 * branch itself, so a request naming a branch the user cannot reach is refused regardless
 * of what this dropdown offered.
 */
export function TransferForm({
  branches,
  sourceBranches,
  products,
  defaultSourceId,
}: {
  branches: { id: string; name: string }[];
  sourceBranches: { id: string; name: string }[];
  products: ProductOption[];
  defaultSourceId: string;
}) {
  const router = useRouter();
  const [fromBranchId, setFromBranchId] = useState(defaultSourceId);
  const [toBranchId, setToBranchId] = useState('');
  const [lines, setLines] = useState<BuilderLine[]>([]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const short = lines.filter((line) => {
    const product = products.find((p) => p.id === line.productId);
    return product?.available !== undefined && line.quantity > product.available;
  });

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await createTransfer({
      fromBranchId,
      toBranchId,
      notes: notes.trim() || undefined,
      items: lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
    });

    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.push(`/transfers/${result.data.transferId}`);
    router.refresh();
  }

  const valid =
    lines.length > 0 &&
    lines.every((line) => line.quantity > 0) &&
    toBranchId !== '' &&
    toBranchId !== fromBranchId;

  return (
    <Card>
      <CardHeader
        title="New transfer"
        description="Stock leaves the sending branch when the transfer is dispatched, not when it is created."
      />
      <FormError message={error} />

      <FormSection title="Branches">
        <LabelledField
          label="From"
          htmlFor="fromBranch"
          required
          hint="Only branches you can move stock out of."
        >
          <select
            id="fromBranch"
            className={inputClass}
            value={fromBranchId}
            onChange={(event) => {
              setFromBranchId(event.target.value);
              // The available quantities shown belong to the previous source, so the
              // lines are cleared rather than left showing figures for the wrong branch.
              setLines([]);
            }}
          >
            {sourceBranches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
        </LabelledField>

        <LabelledField label="To" htmlFor="toBranch" required>
          <select
            id="toBranch"
            className={inputClass}
            value={toBranchId}
            onChange={(event) => setToBranchId(event.target.value)}
          >
            <option value="">Select a destination</option>
            {branches
              .filter((branch) => branch.id !== fromBranchId)
              .map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
          </select>
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
            Quantities available at the sending branch are shown as you search.
          </p>
        </div>

        <LineItemBuilder products={products} lines={lines} onChange={setLines} showAvailable />

        {short.length > 0 && (
          <Alert tone="warning" className="mt-3">
            Some quantities exceed the stock held at the sending branch. Dispatch will be refused
            unless the count is corrected first.
          </Alert>
        )}
      </section>

      <div className="flex justify-end gap-2 px-5 py-4">
        <Button type="button" variant="secondary" onClick={() => router.back()} disabled={busy}>
          Cancel
        </Button>
        <Button loading={busy} disabled={!valid} onClick={() => void submit()}>
          Create transfer
        </Button>
      </div>
    </Card>
  );
}
