'use client';

import { useState } from 'react';
import Image from 'next/image';
import { Alert, buttonClasses, Field } from '@carl/ui';

import {
  confirmOwnerTotpEnrollment,
  disableOwnerTotp,
  startOwnerTotpEnrollment,
} from '@/server/owner-mfa-actions';

const codeInputClass = 'max-w-[12rem] text-center text-lg tracking-[0.4em]';

/**
 * Two-step verification for the owner console.
 *
 * The QR code and the secret are shown once, while the app is being added, and are never
 * stored by this component beyond that. The rules — which codes are accepted, how a factor is
 * confirmed, what it takes to switch it off — all live in Supabase Auth and in the server
 * actions, not here: this form collects and reports.
 */
export function TwoFactorSection({ enrolled }: { enrolled: boolean }) {
  const [on, setOn] = useState(enrolled);
  const [enrolment, setEnrolment] = useState<{
    factorId: string;
    qrCode: string;
    secret: string;
  } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function begin() {
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await startOwnerTotpEnrollment();
    setBusy(false);
    if (result.ok) setEnrolment(result.data);
    else setError(result.message);
  }

  async function confirm(formData: FormData) {
    if (!enrolment) return;
    setBusy(true);
    setError(null);
    const result = await confirmOwnerTotpEnrollment({
      factorId: enrolment.factorId,
      code: formData.get('code'),
    });
    setBusy(false);
    if (result.ok) {
      setEnrolment(null);
      setOn(true);
      setDone('Two-step verification is on. Your console now asks for a code after your PIN.');
    } else {
      setError(result.message);
    }
  }

  async function remove(formData: FormData) {
    setBusy(true);
    setError(null);
    const result = await disableOwnerTotp({ code: formData.get('code') });
    setBusy(false);
    if (result.ok) {
      setOn(false);
      setRemoving(false);
      setDone('Two-step verification is off. Your PIN alone now opens the console.');
    } else {
      setError(result.message);
    }
  }

  return (
    <div className="space-y-4 p-4">
      {!on && !enrolment && (
        <Alert tone="warning" title="Your PIN is the only thing protecting this console">
          This console can onboard, suspend and bill every business on Carl. Add an authenticator
          app so a stolen or guessed PIN is not enough on its own.
        </Alert>
      )}
      {done && <Alert tone="positive" title={done} />}
      {error && (
        <Alert tone="danger" title="That did not work">
          {error}
        </Alert>
      )}

      {enrolment ? (
        <form action={confirm} className="space-y-4">
          <p className="text-sm text-[color:var(--color-ink-muted)]">
            Scan this with Google Authenticator, 1Password, Authy or any authenticator app, then
            type the 6-digit code it shows.
          </p>
          {/* Supabase returns the QR as an inline SVG data URL. */}
          <Image
            src={enrolment.qrCode}
            alt="QR code for your authenticator app"
            width={200}
            height={200}
            unoptimized
            className="rounded-lg border border-[color:var(--color-border)] bg-white p-2"
          />
          <details className="text-sm text-[color:var(--color-ink-muted)]">
            <summary className="cursor-pointer">Can&apos;t scan it?</summary>
            <p className="mt-2 break-all">
              Enter this key by hand:{' '}
              <code className="font-medium text-[color:var(--color-ink)]">{enrolment.secret}</code>
            </p>
          </details>
          <Field
            label="Code from the app"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            pattern="[0-9]{6}"
            maxLength={6}
            className={codeInputClass}
          />
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className={buttonClasses({ variant: 'primary' })}>
              {busy ? 'Checking…' : 'Turn on'}
            </button>
            <button
              type="button"
              onClick={() => setEnrolment(null)}
              className={buttonClasses({ variant: 'ghost' })}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : on ? (
        removing ? (
          <form action={remove} className="space-y-4">
            <p className="text-sm text-[color:var(--color-ink-muted)]">
              Enter a current code to switch it off. After this, your PIN alone opens the console.
            </p>
            <Field
              label="Code from the app"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              pattern="[0-9]{6}"
              maxLength={6}
              className={codeInputClass}
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={busy}
                className={buttonClasses({ variant: 'danger' })}
              >
                {busy ? 'Checking…' : 'Turn off'}
              </button>
              <button
                type="button"
                onClick={() => setRemoving(false)}
                className={buttonClasses({ variant: 'ghost' })}
              >
                Keep it on
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-3">
            <p className="text-sm">
              On. Your console asks for a code from your authenticator app after your PIN.
            </p>
            <button
              type="button"
              onClick={() => setRemoving(true)}
              className={buttonClasses({ variant: 'ghost' })}
            >
              Turn off
            </button>
          </div>
        )
      ) : (
        <button
          type="button"
          onClick={() => void begin()}
          disabled={busy}
          className={buttonClasses({ variant: 'primary' })}
        >
          {busy ? 'Preparing…' : 'Add an authenticator app'}
        </button>
      )}
    </div>
  );
}
