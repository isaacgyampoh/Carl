'use client';

import { useEffect, useRef, useState } from 'react';

import { signInWithPin } from '@/server/platform-auth-actions';

const LENGTH = 4;

/**
 * What the owner is told when something goes wrong.
 *
 * An ALLOWLIST, deliberately, not a list of things to hide. Only two conditions have a
 * message of their own; everything else — a dropped connection, an expired key, a database
 * that is not answering, an error nobody has thought of yet — becomes the same neutral
 * sentence.
 *
 * Written the other way round, as a set of technical errors to suppress, the first
 * unanticipated failure would put "The database could not be reached." in front of a
 * shopkeeper. That is exactly what happened before this existed.
 *
 * The real cause is not lost: the server action logs it.
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
      return { text: serverMessage, retryable: false };
    case 'SESSION_CREATION_FAILED':
      /*
       * The PIN was right and the session could not be created. Telling the owner to check
       * their connection would send them to restart a router over a server-side fault, which
       * is exactly what happened when the administrator's Auth account was malformed.
       */
      return { text: serverMessage, retryable: true };
    default:
      return { text: 'We’re having trouble connecting right now.', retryable: true };
  }
}

/**
 * Four digits.
 *
 * A real input styled as four boxes rather than a rendered keypad: a keypad cannot be typed
 * on, fights password managers, and on a phone duplicates the numeric keyboard `inputMode`
 * already raises. It submits on the fourth digit, so a partial PIN never leaves the device,
 * and there is no Confirm button because four digits is the whole credential.
 */
export function OwnerPinPad({ next }: { next?: string | undefined }) {
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
      const result = await signInWithPin({ pin: digits, next });
      if (result.ok) {
        /*
         * Where to go is the server's answer, from the session it just verified — the console,
         * or the PIN change it requires. A full load rather than a client transition, so nothing
         * rendered before the sign-in (by this app or any other on this device) is reused.
         */
        window.location.replace(result.data.destination);
        return;
      }
      setStatus('error');
      setError(messageFor(result.code, result.message));
      setDigits('');
      submitted.current = false;
      inputRef.current?.focus();
    })();
  }, [digits, next]);

  function retry() {
    setStatus('idle');
    setError(null);
    setDigits('');
    submitted.current = false;
    inputRef.current?.focus();
  }

  return (
    <div className="space-y-8">
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
        <div className="flex justify-center gap-3 sm:gap-4" aria-hidden="true">
          {Array.from({ length: LENGTH }, (_, index) => {
            const done = index < digits.length;
            const active = index === digits.length && status !== 'checking';
            return (
              <div
                key={index}
                className={[
                  'flex h-[4.5rem] w-16 items-center justify-center rounded-2xl border text-3xl',
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
        {error && (
          <div className="space-y-3">
            <p className="text-sm text-[color:var(--color-danger)]">{error.text}</p>
            {error.retryable && (
              <button
                type="button"
                onClick={retry}
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
