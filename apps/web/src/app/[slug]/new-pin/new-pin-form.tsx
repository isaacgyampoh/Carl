'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, buttonClasses } from '@carl/ui';

import { changeMyPin } from '@/server/member-auth-actions';

const inputClass =
  'h-14 w-full rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-4 text-center text-2xl tracking-[0.6em] outline-none focus-visible:outline-2 focus-visible:outline-[color:var(--color-brand)]';

/**
 * Two boxes, because a mistyped PIN nobody can recover is worse than one extra field.
 *
 * The rules — four digits, not an obvious sequence, not already used by a colleague — are
 * enforced in the database. Repeating them here would create a second definition of
 * "acceptable" that drifts, and the browser's copy is the one an attacker can skip.
 */
export function NewPinForm({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(formData: FormData) {
    setBusy(true);
    setError(null);
    const result = await changeMyPin({
      tenantId,
      newPin: formData.get('newPin'),
      confirmPin: formData.get('confirmPin'),
    });
    setBusy(false);
    if (result.ok) {
      router.replace('/dashboard');
      router.refresh();
    } else {
      setError(result.message);
    }
  }

  return (
    <form action={submit} className="space-y-5">
      {error && (
        <Alert tone="danger" title="Could not set that PIN">
          {error}
        </Alert>
      )}
      <div className="space-y-2">
        <label htmlFor="newPin" className="block text-sm font-medium">
          New PIN
        </label>
        <input
          id="newPin"
          name="newPin"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          required
          pattern="[0-9]{4}"
          maxLength={4}
          autoFocus
          className={inputClass}
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="confirmPin" className="block text-sm font-medium">
          Enter it again
        </label>
        <input
          id="confirmPin"
          name="confirmPin"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          required
          pattern="[0-9]{4}"
          maxLength={4}
          className={inputClass}
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        className={buttonClasses({ variant: 'primary', className: 'h-12 w-full' })}
      >
        {busy ? 'Saving…' : 'Save my PIN'}
      </button>
      <p className="text-center text-xs text-[color:var(--color-text-muted)]">
        Do not use 1234, 0000, or your year of birth.
      </p>
    </form>
  );
}
