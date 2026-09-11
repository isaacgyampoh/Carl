'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@carl/ui';

import { inputClass } from '@/components/form';
import { formText } from '@/lib/form-data';
import { adjustStock, type StockAdjustmentKind } from '@/server/stock-actions';

const CHOICES: readonly (readonly [StockAdjustmentKind, string])[] = [
  ['ADD', 'Add stock'],
  ['REMOVE', 'Remove stock'],
  ['DAMAGE', 'Damaged'],
  ['EXPIRED', 'Expired'],
  ['THEFT', 'Lost or stolen'],
];

/**
 * Changing the stock of one product at one branch.
 *
 * Quantities are always entered as positive numbers; the choice decides the direction. A
 * reason is required because the ledger is the only answer to "where did it go?" later.
 */
export function AdjustStockForm({
  branchId,
  productId,
  compact = false,
}: {
  branchId: string;
  productId: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  if (!open) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button size="sm" variant={compact ? 'ghost' : 'secondary'} onClick={() => setOpen(true)}>
          Adjust stock
        </Button>
        {message && (
          <span
            className={`text-xs ${message.ok ? 'text-[color:var(--color-ink-muted)]' : 'text-[color:var(--color-danger)]'}`}
          >
            {message.text}
          </span>
        )}
      </div>
    );
  }

  return (
    <form
      className="flex flex-wrap items-end justify-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setMessage(null);
        startTransition(async () => {
          const result = await adjustStock({
            branchId,
            productId,
            kind: formText(data, 'kind'),
            quantity: Number(formText(data, 'quantity')),
            reason: formText(data, 'reason'),
          });
          if (!result.ok) {
            setMessage({
              text: result.fieldErrors
                ? (Object.values(result.fieldErrors)[0] ?? result.message)
                : result.message,
              ok: false,
            });
            return;
          }
          setMessage({
            text: `Stock is now ${result.data.newQuantity.toLocaleString('en-GH')}.`,
            ok: true,
          });
          setOpen(false);
          router.refresh();
        });
      }}
    >
      <label className="flex flex-col gap-1 text-xs font-medium">
        Change
        <select name="kind" className={`${inputClass} h-9`} defaultValue="ADD">
          {CHOICES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Quantity
        <input
          name="quantity"
          type="number"
          step="any"
          min="0"
          required
          className={`${inputClass} h-9 w-24 tabular-nums`}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Reason
        <input
          name="reason"
          required
          minLength={3}
          placeholder="e.g. new delivery"
          className={`${inputClass} h-9 w-44`}
        />
      </label>
      <Button size="sm" type="submit" loading={pending}>
        Save
      </Button>
      <Button
        size="sm"
        type="button"
        variant="ghost"
        onClick={() => setOpen(false)}
        disabled={pending}
      >
        Cancel
      </Button>
      {message && !message.ok && (
        <span className="w-full text-right text-xs text-[color:var(--color-danger)]">
          {message.text}
        </span>
      )}
    </form>
  );
}
