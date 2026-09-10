import { useEffect, useRef, useState } from 'react';

import type { Cashier, CashierSession } from '../lib/cashier-session';

const LENGTH = 4;

/**
 * Starting a shift at the till.
 *
 * Four digits and nothing else. The terminal already knows which shop and branch it serves
 * — `activate_device` bound it — so asking a cashier to also identify their employer would
 * be a question the hardware can already answer, and a field to mistype during a queue.
 *
 * No rendered keypad: POS machines have a keyboard, a touchscreen that raises one, or a
 * barcode scanner that behaves like a keyboard. A drawn keypad is a worse version of all
 * three and cannot be typed on.
 *
 * The PIN is verified by Carl's server, never here. Verification needs the service-role key
 * and the device pepper, and neither may sit in a bundle installed on a shop counter.
 */
export function SignIn({
  session,
  tenantName,
  branchName,
  onSignedIn,
}: {
  session: CashierSession;
  tenantName: string;
  branchName: string;
  onSignedIn: (cashier: Cashier) => void;
}): React.JSX.Element {
  const [digits, setDigits] = useState('');
  const [status, setStatus] = useState<'idle' | 'checking' | 'error'>('idle');
  const [detail, setDetail] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const submitted = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (digits.length !== LENGTH || submitted.current) return;
    submitted.current = true;
    setStatus('checking');
    setDetail(null);

    void (async () => {
      /*
       * Defence at the caller as well as in the session.
       *
       * `signInWithPin` is written never to throw, and this catch exists because the cost of
       * being wrong about that is a till nobody can sign into: the PIN pad is disabled while
       * `status` is 'checking', and `submitted` blocks a second attempt, so an unhandled
       * rejection leaves a cashier looking at a dead keypad with a queue in front of them.
       * The only recovery is restarting the application.
       */
      const result = await session
        .signInWithPin(digits)
        .catch(() => ({ ok: false as const, detail: 'Sign-in failed unexpectedly. Try again.' }));
      if (result.ok) {
        onSignedIn(result.cashier);
        return;
      }
      setStatus('error');
      setDetail(result.detail);
      setDigits('');
      submitted.current = false;
      inputRef.current?.focus();
    })();
  }, [digits, session, onSignedIn]);

  return (
    <main className="signin">
      <header className="signin__header">
        {/* Shown before anything is sold: a terminal activated against the wrong branch is
            otherwise invisible until the takings land in the wrong place. */}
        <h1>{tenantName}</h1>
        <p>{branchName}</p>
      </header>

      <div className="signin__pin" onClick={() => inputRef.current?.focus()} role="presentation">
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
              setDetail(null);
            }
            setDigits(next);
          }}
          className="signin__field"
        />
        <div className="signin__boxes" aria-hidden="true">
          {Array.from({ length: LENGTH }, (_, index) => (
            <div
              key={index}
              className={[
                'signin__box',
                index < digits.length ? 'signin__box--filled' : '',
                status === 'error' ? 'signin__box--error' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {index < digits.length ? '•' : ''}
            </div>
          ))}
        </div>
      </div>

      <p className="signin__status" role="status" aria-live="polite">
        {status === 'checking' ? 'Checking…' : (detail ?? 'Enter your PIN to start selling')}
      </p>
    </main>
  );
}
