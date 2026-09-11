'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Alert, Button, Field } from '@carl/ui';

import { formText } from '@/lib/form-data';
import { createBranch } from '@/server/branch-actions';

/**
 * Opening another branch.
 *
 * A branch is a place, not a computer: each branch can have as many POS terminals as it
 * needs, added under Terminals once the branch exists.
 */
export function AddBranchForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!open) return <Button onClick={() => setOpen(true)}>Add branch</Button>;

  return (
    <form
      className="w-full space-y-4 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setError(null);
        startTransition(async () => {
          const result = await createBranch({
            name: formText(data, 'name'),
            code: formText(data, 'code'),
            address: formText(data, 'address') || undefined,
            phone: formText(data, 'phone') || undefined,
          });
          if (!result.ok) {
            setError(
              result.fieldErrors
                ? (Object.values(result.fieldErrors)[0] ?? result.message)
                : result.message,
            );
            return;
          }
          setOpen(false);
          router.refresh();
        });
      }}
    >
      <h2 className="text-base font-semibold">New branch</h2>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Branch name"
          name="name"
          required
          placeholder="Kumasi Branch"
          autoComplete="off"
        />
        <Field
          label="Branch code"
          name="code"
          required
          placeholder="kumasi"
          hint="Short, lowercase."
          autoComplete="off"
        />
        <Field label="Address" name="address" autoComplete="off" />
        <Field label="Phone" name="phone" type="tel" autoComplete="off" />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          Add branch
        </Button>
      </div>
    </form>
  );
}
