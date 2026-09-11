'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Alert, Button, Field } from '@carl/ui';

import { inputClass } from '@/components/form';
import { formText } from '@/lib/form-data';
import { recordExpense } from '@/server/expense-actions';

const METHODS = [
  ['CASH', 'Cash'],
  ['MOMO', 'Mobile money'],
  ['BANK_TRANSFER', 'Bank transfer'],
  ['CARD', 'Card'],
  ['OTHER', 'Other'],
] as const;

/**
 * Recording an expense for the branch being worked in.
 *
 * The business and branch come from the session. Whether the entry is approved straight
 * away or queued is decided by the database from the person's permissions, not by this form.
 */
export function RecordExpenseForm({
  branchId,
  branchName,
  categories,
}: {
  branchId: string;
  branchName: string;
  categories: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!open) {
    return (
      <div className="flex flex-col items-end gap-1">
        {done && <span className="text-sm text-[color:var(--color-ink-muted)]">{done}</span>}
        <Button
          onClick={() => {
            setOpen(true);
            setDone(null);
          }}
        >
          Record expense
        </Button>
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <form
      className="w-full space-y-4 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setError(null);
        startTransition(async () => {
          const reference = formText(data, 'reference').trim();
          const categoryId = formText(data, 'categoryId');
          const result = await recordExpense({
            branchId,
            description: formText(data, 'description'),
            amount: Number(formText(data, 'amount')),
            method: formText(data, 'method'),
            expenseDate: formText(data, 'expenseDate') || undefined,
            ...(reference ? { reference } : {}),
            ...(categoryId ? { categoryId } : {}),
          });
          if (!result.ok) {
            setError(
              result.fieldErrors
                ? (Object.values(result.fieldErrors)[0] ?? result.message)
                : result.message,
            );
            return;
          }
          setDone(`Recorded as ${result.data.reference}.`);
          setOpen(false);
          router.refresh();
        });
      }}
    >
      <h2 className="text-base font-semibold">New expense at {branchName}</h2>
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="What was it for?" name="description" required autoComplete="off" />
        <Field
          label="Amount (GHS)"
          name="amount"
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          required
        />
        <div className="flex flex-col gap-1.5">
          <label htmlFor="method" className="text-sm font-medium">
            Paid by
          </label>
          <select id="method" name="method" defaultValue="CASH" className={inputClass}>
            {METHODS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Reference"
          name="reference"
          hint="Required for mobile money and bank transfers."
          autoComplete="off"
        />
        <Field label="Date" name="expenseDate" type="date" defaultValue={today} max={today} />
        {categories.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="categoryId" className="text-sm font-medium">
              Category
            </label>
            <select id="categoryId" name="categoryId" defaultValue="" className={inputClass}>
              <option value="">No category</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          Record expense
        </Button>
      </div>
    </form>
  );
}
