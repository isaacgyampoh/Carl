'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { signInWithMemberPin } from '@/server/member-auth-actions';

const LENGTH = 4;

/**
 * What a shopkeeper is told when something goes wrong.
 *
 * An ALLOWLIST, not a list of things to suppress. Three conditions have their own message;
 * everything else becomes one neutral sentence, so an error nobody anticipated cannot put
 * "The database could not be reached." in front of a cashier mid-shift.
 *
 * The real cause is logged server-side.
 */
function messageFor(
  code: string | undefined,
  serverMessage: string,
): {
  text: string;
  retryable: boolean;
} {
  switch (code) {
    case undefined:
      // No code at all is the same unknown condition as an unrecognised one.
      return { text: 'We’re having trouble connecting right now.', retryable: true };
    case 'INVALID_PIN':
      return { text: 'That PIN is not correct.', retryable: false };
    case 'PIN_LOCKED':
    case 'TENANT_SUSPENDED':
      return { text: serverMessage, retryable: false };
    default:
      return { text: 'We’re having trouble connecting right now.', retryable: true };
  }
}

/**
 * Four digits, and nothing else.
 *
 * The same input as the owner's: a real field styled as four boxes, not a rendered keypad.
 * A keypad cannot be typed on, fights password managers, and on a phone duplicates the
 * numeric keyboard `inputMode` already raises.
 *
 * It submits on the fourth digit, so a partial PIN never leaves the device, and there is no
 * Confirm button because four digits is the whole credential.
 */
export function MemberPinPad({ slug }: { slug: string }) {
  const router = useRouter();
  const [digits, setDigits] = useState('');
  const [status, setStatus] = useState<'idle' | 'checking' | 'error'>('idle');
  const [error, setError] = useState<{ text: string; retryable: boolean } | null>(null);
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
      const result = await signInWithMemberPin({ slug, pin: digits });
      if (result.ok) {
        router.replace(
          result.data.mustChangePin
            ? `/${slug}/new-pin?tenant=${encodeURIComponent(result.data.tenantId)}`
            : '/dashboard',
        );
        router.refresh();
        return;
      }
      setStatus('error');
      setError(messageFor(result.code, result.message));
      setDigits('');
      submitted.current = false;
      inputRef.current?.focus();
    })();
  }, [digits, router, slug]);

  return (
    <div className="space-y-6">
      <div className="relative" onClick={() => inputRef.current?.focus()} role="presentation">
        {/* Visually hidden rather than removed, so the device keyboard, password managers
            and assistive technology all still reach the real field. */}
        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="PIN"
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
        <div className="flex justify-center gap-3" aria-hidden="true">
          {Array.from({ length: LENGTH }, (_, index) => {
            const done = index < digits.length;
            const active = index === digits.length && status !== 'checking';
            return (
              <div
                key={index}
                className={[
                  'flex h-16 w-14 items-center justify-center rounded-xl border text-2xl transition-colors',
                  done
                    ? 'border-[color:var(--color-brand)] bg-[color:var(--color-surface)]'
                    : 'border-[color:var(--color-border)] bg-[color:var(--color-surface-muted)]',
                  active ? 'ring-2 ring-[color:var(--color-brand)]' : '',
                  status === 'error' ? 'border-[color:var(--color-danger)]' : '',
                ].join(' ')}
              >
                {done ? '•' : null}
              </div>
            );
          })}
        </div>
      </div>

      <div className="min-h-16 text-center" role="status" aria-live="polite">
        {status === 'checking' && (
          <span className="text-sm text-[color:var(--color-text-muted)]">Checking…</span>
        )}
        {error && (
          <div className="space-y-3">
            <p className="text-sm text-[color:var(--color-danger)]">{error.text}</p>
            {error.retryable && (
              <button
                type="button"
                onClick={() => {
                  setStatus('idle');
                  setError(null);
                  setDigits('');
                  submitted.current = false;
                  inputRef.current?.focus();
                }}
                className="rounded-lg border border-[color:var(--color-border)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-surface-muted)]"
              >
                Try again
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
