'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button, Field } from '@carl/ui';

import { formText } from '@/lib/form-data';
import { setClientMonthlyFee } from '@/server/platform-actions';

/**
 * The amount this client pays each month, as agreed with them.
 *
 * Every client can be on a different price. Billing stays manual: this only records the
 * figure that invoices and payments are measured against.
 */
export function FeeEditor({ tenantId, currentFee }: { tenantId: string; currentFee: number }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  if (!editing) {
    return (
      <div className="flex items-center gap-3">
        <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
          Change monthly fee
        </Button>
        {message && <span className="text-sm text-[color:var(--color-text-muted)]">{message}</span>}
      </div>
    );
  }

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const monthlyFee = Number(formText(data, 'monthlyFee'));
        const note = formText(data, 'note').trim();
        setMessage(null);
        startTransition(async () => {
          const result = await setClientMonthlyFee({
            tenantId,
            monthlyFee,
            ...(note ? { note } : {}),
          });
          if (!result.ok) {
            setMessage(result.message);
            return;
          }
          setEditing(false);
          setMessage('Monthly fee updated.');
          router.refresh();
        });
      }}
    >
      <Field
        label="Monthly fee (GHS)"
        name="monthlyFee"
        type="number"
        inputMode="decimal"
        min={0}
        step="0.01"
        defaultValue={(currentFee / 100).toFixed(2)}
        required
      />
      <Field label="Note" name="note" hint="Optional, e.g. what was agreed." autoComplete="off" />
      <Button type="submit" size="sm" loading={pending}>
        Save
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => setEditing(false)}
        disabled={pending}
      >
        Cancel
      </Button>
      {message && <span className="text-sm text-[color:var(--color-danger)]">{message}</span>}
    </form>
  );
}
