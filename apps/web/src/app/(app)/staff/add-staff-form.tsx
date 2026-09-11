'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Alert, Button, Field } from '@carl/ui';

import { formText, formTexts } from '@/lib/form-data';
import { inputClass } from '@/components/form';
import { createStaffMember } from '@/server/staff-actions';

export interface RoleOption {
  key: string;
  name: string;
}
export interface BranchOption {
  id: string;
  name: string;
}

/**
 * Adding a member of staff.
 *
 * The tenant is never a field. It comes from the verified session on the server, so nothing
 * here can place someone in another business. Roles offered are only those the manager is
 * allowed to grant, and the database refuses anything else regardless.
 *
 * The PIN is typed by the manager and handed to the person directly. It is not shown again,
 * stored readably, or sent anywhere but the server, which keeps only a hash.
 */
export function AddStaffForm({
  roles,
  branches,
}: {
  roles: RoleOption[];
  branches: BranchOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  if (!open) {
    return (
      <div className="flex flex-col items-end gap-2">
        {added && <p className="text-sm text-[color:var(--color-ink-muted)]">{added}</p>}
        <Button
          onClick={() => {
            setOpen(true);
            setAdded(null);
          }}
        >
          Add staff
        </Button>
      </div>
    );
  }

  function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    const fullName = formText(data, 'fullName');
    setError(null);
    startTransition(async () => {
      const result = await createStaffMember({
        fullName,
        jobTitle: formText(data, 'jobTitle') || undefined,
        roleKey: formText(data, 'roleKey'),
        branchIds: formTexts(data, 'branchIds'),
        pin: formText(data, 'pin'),
        confirmPin: formText(data, 'confirmPin'),
      });
      if (!result.ok) {
        setError(
          result.fieldErrors
            ? (Object.values(result.fieldErrors)[0] ?? result.message)
            : result.message,
        );
        return;
      }
      setAdded(
        `${fullName} was added. Give them their PIN — they will choose their own when they first sign in.`,
      );
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <form
      className="w-full space-y-4 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit(event.currentTarget);
      }}
    >
      <h2 className="text-base font-semibold">New member of staff</h2>
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name" name="fullName" required autoComplete="off" />
        <Field label="Job title" name="jobTitle" hint="Optional" autoComplete="off" />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="roleKey" className="text-sm font-medium">
          Role
        </label>
        <select id="roleKey" name="roleKey" required className={inputClass} defaultValue="">
          <option value="" disabled>
            Choose a role
          </option>
          {roles.map((role) => (
            <option key={role.key} value={role.key}>
              {role.name}
            </option>
          ))}
        </select>
      </div>

      {branches.length > 1 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Branches</legend>
          <p className="text-xs text-[color:var(--color-ink-muted)]">
            Leave all unticked to allow every branch.
          </p>
          <div className="flex flex-wrap gap-4">
            {branches.map((branch) => (
              <label key={branch.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-5 shrink-0 accent-[color:var(--color-brand)]"
                  name="branchIds"
                  value={branch.id}
                />
                {branch.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="PIN"
          name="pin"
          type="password"
          inputMode="numeric"
          maxLength={4}
          pattern="[0-9]{4}"
          required
          autoComplete="new-password"
          hint="Four digits, unique in your business."
        />
        <Field
          label="Confirm PIN"
          name="confirmPin"
          type="password"
          inputMode="numeric"
          maxLength={4}
          pattern="[0-9]{4}"
          required
          autoComplete="new-password"
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          Add staff
        </Button>
      </div>
    </form>
  );
}
