'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { signInWithPin } from '@/server/platform-auth-actions';

const LENGTH = 4;

/**
 * A four-digit PIN entry.
 *
 * ## Why there is no on-screen keypad
 *
 * The owner uses a phone, a tablet and a Mac. A rendered keypad is a worse version of the
 * keyboard every one of those already has: it cannot be typed on, it fights password
 * managers, and on a phone it duplicates the numeric keyboard `inputMode` already brings
 * up. So this is a real input — typed, pasted, or filled by the device — styled as four
 * boxes.
 *
 * ## Why it submits itself
 *
 * Four digits is the whole credential; a Confirm button would add a tap that carries no
 * decision. It submits on the fourth digit and never before, so a partial PIN is never
 * sent anywhere.
 *
 * The PIN is held in component state for the moment it takes to submit and is cleared on
 * failure. It is never written to localStorage, never put in the URL, and never logged.
 */
export function PinPad() {
  const router = useRouter();
  const [digits, setDigits] = useState('');
  const [status, setStatus] = useState<'idle' | 'checking' | 'error' | 'locked'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const submitted = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (digits.length !== LENGTH || submitted.current) return;
    submitted.current = true;
    setStatus('checking');
    setMessage(null);

    void (async () => {
      const result = await signInWithPin({ pin: digits });
      if (result.ok) {
        // The session cookie is already set by the server action.
        router.replace(result.data.mustChangePin ? '/platform/settings?change_pin=1' : '/platform');
        router.refresh();
        return;
      }
      setStatus(result.code === 'PIN_LOCKED' ? 'locked' : 'error');
      setMessage(result.message);
      setDigits('');
      submitted.current = false;
      inputRef.current?.focus();
    })();
  }, [digits, router]);

  const filled = digits.length;

  return (
    <div className="space-y-6">
      <div className="relative" onClick={() => inputRef.current?.focus()} role="presentation">
        {/* The real field. Visually hidden rather than display:none, so the device keyboard,
            password managers and assistive technology all still reach it. */}
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
            if (status === 'error' || status === 'locked') {
              setStatus('idle');
              setMessage(null);
            }
            setDigits(next);
          }}
          className="absolute inset-0 h-full w-full cursor-default opacity-0"
        />
        <div
          className={`flex justify-center gap-3 ${status === 'error' ? 'animate-[shake_0.3s]' : ''}`}
          aria-hidden="true"
        >
          {Array.from({ length: LENGTH }, (_, index) => {
            const active = index === filled && status !== 'checking';
            const done = index < filled;
            return (
              <div
                key={index}
                className={[
                  'flex h-16 w-14 items-center justify-center rounded-xl border text-2xl transition-colors',
                  done
                    ? 'border-[color:var(--color-brand)] bg-[color:var(--color-surface)]'
                    : 'border-[color:var(--color-border)] bg-[color:var(--color-surface-muted)]',
                  active ? 'ring-2 ring-[color:var(--color-brand)]' : '',
                  status === 'error' || status === 'locked'
                    ? 'border-[color:var(--color-danger)]'
                    : '',
                ].join(' ')}
              >
                {done ? <span className="text-[color:var(--color-text)]">•</span> : null}
              </div>
            );
          })}
        </div>
      </div>

      <p className="min-h-10 text-center text-sm" role="status" aria-live="polite">
        {status === 'checking' && (
          <span className="text-[color:var(--color-text-muted)]">Checking…</span>
        )}
        {message && <span className="text-[color:var(--color-danger)]">{message}</span>}
      </p>

      <style>{`@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}`}</style>
    </div>
  );
}
