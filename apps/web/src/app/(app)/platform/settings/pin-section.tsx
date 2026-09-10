'use client';

import { useState } from 'react';
import { Alert, Field, buttonClasses } from '@carl/ui';

import { changeOwnerPin } from '@/server/platform-auth-actions';

const inputClass =
  'h-11 w-full max-w-[12rem] rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 text-center text-lg tracking-[0.4em] outline-none focus-visible:outline-2 focus-visible:outline-[color:var(--color-brand)]';

/**
 * Changing the owner PIN.
 *
 * The rules — current PIN required, the published default refused, obvious sequences
 * refused — are enforced in the database, not here. This form only collects and reports.
 * Duplicating the rules in the browser would create two definitions of "acceptable" that
 * drift, and the browser's copy is the one an attacker can skip.
 */
export function PinSection({ isDefault }: { isDefault: boolean }) {
  const [open, setOpen] = useState(isDefault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(formData: FormData) {
    setBusy(true);
    setError(null);
    const result = await changeOwnerPin({
      currentPin: formData.get('currentPin'),
      newPin: formData.get('newPin'),
      confirmPin: formData.get('confirmPin'),
    });
    setBusy(false);
    if (result.ok) {
      setDone(true);
      setOpen(false);
    } else {
      setError(result.message);
    }
  }

  return (
    <div className="space-y-4 p-4">
      {isDefault && !done && (
        <Alert tone="danger" title="You are still using the default PIN">
          1024 is published in Carl&apos;s setup documentation. Anyone who knows it can open this
          console. Change it now.
        </Alert>
      )}
      {done && <Alert tone="positive" title="PIN changed" />}
      {error && (
        <Alert tone="danger" title="Could not change the PIN">
          {error}
        </Alert>
      )}

      {open ? (
        <form action={submit} className="space-y-4">
          <Field label="Current PIN">
            <input
              name="currentPin"
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              required
              pattern="[0-9]{4}"
              maxLength={4}
              className={inputClass}
            />
          </Field>
          <Field label="New PIN">
            <input
              name="newPin"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              required
              pattern="[0-9]{4}"
              maxLength={4}
              className={inputClass}
            />
          </Field>
          <Field label="Confirm new PIN">
            <input
              name="confirmPin"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              required
              pattern="[0-9]{4}"
              maxLength={4}
              className={inputClass}
            />
          </Field>
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className={buttonClasses({ variant: 'primary' })}>
              {busy ? 'Changing…' : 'Change PIN'}
            </button>
            {!isDefault && (
              <button
                type="button"
                onClick={() => setOpen(false)}
                className={buttonClasses({ variant: 'ghost' })}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => {
            setDone(false);
            setOpen(true);
          }}
          className={buttonClasses({ variant: 'secondary' })}
        >
          Change PIN
        </button>
      )}
    </div>
  );
}
