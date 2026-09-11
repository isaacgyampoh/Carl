'use client';

import { useEffect, useRef, useState } from 'react';

import { verifyOwnerTotp } from '@/server/owner-mfa-actions';
import { signOut } from '@/server/session-actions';

const LENGTH = 6;

/**
 * The code from the owner's authenticator app, asked for after the PIN.
 *
 * The same shape as the PIN pad, and the same discipline: it submits on the last digit, the
 * code never appears in a log, and every failure says one neutral sentence. Where it leads is
 * the server's answer, never a destination the browser chose.
 */
export function OwnerTotpPrompt({ next }: { next?: string | undefined }) {
  const [digits, setDigits] = useState('');
  const [status, setStatus] = useState<'idle' | 'checking' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const submitted = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (digits.length !== LENGTH || submitted.current) return;
    submitted.current = true;
    setStatus('checking');
    setError(null);

    void (async () => {
      const result = await verifyOwnerTotp({ code: digits, next });
      if (result.ok) {
        window.location.replace(result.data.destination);
        return;
      }
      setStatus('error');
      setError(result.message);
      setDigits('');
      submitted.current = false;
      inputRef.current?.focus();
    })();
  }, [digits, next]);

  return (
    <div className="space-y-8">
      <div className="relative" onClick={() => inputRef.current?.focus()} role="presentation">
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="Authentication code"
          maxLength={LENGTH}
          value={digits}
          disabled={status === 'checking'}
          onChange={(event) => {
            const next = event.target.value.replace(/\D/g, '').slice(0, LENGTH);
            if (status === 'error') {
              setStatus('idle');
              setError(null);
            }
            setDigits(next);
          }}
          className="absolute inset-0 h-full w-full cursor-default opacity-0"
        />
        <div className="flex justify-center gap-2 sm:gap-3" aria-hidden="true">
          {Array.from({ length: LENGTH }, (_, index) => {
            const done = index < digits.length;
            const active = index === digits.length && status !== 'checking';
            return (
              <div
                key={index}
                className={[
                  'flex h-16 w-11 items-center justify-center rounded-xl border text-2xl',
                  'transition-[border-color,box-shadow] duration-150',
                  done
                    ? 'border-[color:var(--color-ink)] bg-[color:var(--color-surface)]'
                    : 'border-[color:var(--color-border)] bg-[color:var(--color-surface-muted)]',
                  active ? 'ring-2 ring-[color:var(--color-ink)] ring-offset-2' : '',
                  status === 'error' ? 'border-[color:var(--color-danger)]' : '',
                  status === 'checking' ? 'opacity-60' : '',
                ].join(' ')}
              >
                {done ? <span aria-hidden>•</span> : null}
              </div>
            );
          })}
        </div>
      </div>

      <div className="min-h-16 text-center" role="status" aria-live="polite">
        {status === 'checking' && (
          <span className="text-sm text-[color:var(--color-ink-muted)]">Checking…</span>
        )}
        {error && <p className="text-sm text-[color:var(--color-danger)]">{error}</p>}
      </div>

      {/* A way out that does not leave a half-signed-in session sitting on the screen. */}
      <button
        type="button"
        onClick={() => {
          void signOut().then((result) => {
            window.location.replace(result.ok ? result.data.next : '/');
          });
        }}
        className="w-full text-center text-sm text-[color:var(--color-ink-muted)] underline-offset-4 hover:underline"
      >
        Start again
      </button>
    </div>
  );
}
