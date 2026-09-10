'use client';

import { useState } from 'react';
import { Alert, Field, buttonClasses } from '@carl/ui';

import { changeOwnerPin } from '@/server/platform-auth-actions';

/** Wider tracking and centred text, so four digits read as a PIN rather than a word. */
const pinInputClass = 'max-w-[12rem] text-center text-lg tracking-[0.4em]';

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
          {/* Field renders the input itself — it is not a wrapper. Passing an <input> as a
              child spreads it onto the element as `children`, and React refuses to render a
              self-closing tag with children, which took two owner pages down in production. */}
          <Field
            label="Current PIN"
            name="currentPin"
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            required
            pattern="[0-9]{4}"
            maxLength={4}
            className={pinInputClass}
          />
          <Field
            label="New PIN"
            name="newPin"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            required
            pattern="[0-9]{4}"
            maxLength={4}
            className={pinInputClass}
          />
          <Field
            label="Confirm new PIN"
            name="confirmPin"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            required
            pattern="[0-9]{4}"
            maxLength={4}
            className={pinInputClass}
          />
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
