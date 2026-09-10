'use client';

import { useEffect, useRef, useState } from 'react';
import { formatMoney, parseMoney } from '@carl/shared';
import { Alert, Button, cn } from '@carl/ui';

type Method = 'CASH' | 'MOMO' | 'BANK_TRANSFER' | 'CARD';

interface Tender {
  method: Method;
  amount: number;
  reference?: string;
}

const METHODS: readonly { key: Method; label: string; needsReference: boolean }[] = [
  { key: 'CASH', label: 'Cash', needsReference: false },
  { key: 'MOMO', label: 'Mobile money', needsReference: true },
  { key: 'BANK_TRANSFER', label: 'Bank transfer', needsReference: true },
  { key: 'CARD', label: 'Card', needsReference: false },
];

/**
 * Taking payment.
 *
 * ## The quick-cash buttons
 *
 * Most cash sales are settled with a round note. Offering the exact amount and the next
 * few sensible notes removes the most common keypad interaction entirely, which is worth
 * more at a busy till than any other optimisation on this screen.
 *
 * ## Change
 *
 * Shown large, because getting it wrong costs the shop money and the cashier their
 * afternoon. It is computed here for display only — the server recomputes it, and refuses
 * to give change against anything but cash.
 */
export function PaymentPanel({
  total,
  canDiscount: _canDiscount,
  onCancel,
  onConfirm,
}: {
  total: number;
  canDiscount: boolean;
  onCancel: () => void;
  onConfirm: (payments: Tender[]) => Promise<void>;
}) {
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [method, setMethod] = useState<Method>('CASH');
  const [amountText, setAmountText] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  const paid = tenders.reduce((sum, tender) => sum + tender.amount, 0);
  const outstanding = Math.max(total - paid, 0);
  const change = Math.max(paid - total, 0);
  const cashPaid = tenders
    .filter((tender) => tender.method === 'CASH')
    .reduce((sum, tender) => sum + tender.amount, 0);

  useEffect(() => {
    amountRef.current?.focus();
  }, []);

  /** Round notes at or above the outstanding amount. */
  const quickAmounts = (() => {
    const notes = [500, 1000, 2000, 5000, 10000, 20000].map((n) => n * 100);
    const suggestions = notes.filter((n) => n >= outstanding).slice(0, 3);
    return outstanding > 0 ? [outstanding, ...suggestions.filter((n) => n !== outstanding)] : [];
  })();

  function addTender(amount: number) {
    const config = METHODS.find((m) => m.key === method);
    if (config?.needsReference && reference.trim().length === 0) {
      // Carl does not integrate a mobile money API, so this reference is the only link to
      // the actual transfer. The server refuses without it; saying so here saves a failed
      // submission in front of a customer.
      setError(`Enter the ${config.label.toLowerCase()} transaction reference.`);
      return;
    }
    if (amount <= 0) {
      setError('Enter an amount greater than zero.');
      return;
    }

    setTenders((current) => [
      ...current,
      config?.needsReference ? { method, amount, reference: reference.trim() } : { method, amount },
    ]);
    setAmountText('');
    setReference('');
    setError(null);
    amountRef.current?.focus();
  }

  function onAmountEntered() {
    try {
      addTender(parseMoney(amountText));
    } catch {
      setError('That is not a valid amount.');
    }
  }

  async function confirm() {
    if (paid < total) {
      setError('The payments do not cover the total yet.');
      return;
    }
    // Mirrors the server's rule so the cashier is told before submitting, not after.
    if (change > cashPaid) {
      setError('Change can only be given against a cash payment.');
      return;
    }
    setSubmitting(true);
    try {
      await onConfirm(tenders);
    } finally {
      /*
       * `finally`, so the button always comes back.
       *
       * Without it a rejected submit left Confirm spinning for good, with money possibly
       * taken and no way forward except reloading the page — which loses the cart and any
       * knowledge of whether the sale landed.
       */
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Take payment"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
    >
      <div className="flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-[color:var(--color-surface)] sm:rounded-2xl">
        <header className="flex items-baseline justify-between border-b border-[color:var(--color-border)] px-5 py-4">
          <h2 className="text-base font-semibold">Take payment</h2>
          <span className="text-2xl font-semibold tabular-nums tracking-tight">
            {formatMoney(total)}
          </span>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <Alert tone="danger" className="mb-3">
              {error}
            </Alert>
          )}

          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {METHODS.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => {
                  setMethod(option.key);
                  setError(null);
                }}
                aria-pressed={method === option.key}
                className={cn(
                  'h-12 rounded-lg border text-sm font-medium transition-colors',
                  method === option.key
                    ? 'border-[color:var(--color-brand)] bg-[color:var(--color-brand-soft)] text-[color:var(--color-brand-strong)]'
                    : 'border-[color:var(--color-border)] hover:bg-[color:var(--color-surface-muted)]',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          {METHODS.find((m) => m.key === method)?.needsReference && (
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Transaction reference"
              aria-label="Transaction reference"
              className="mb-3 h-12 w-full rounded-lg border border-[color:var(--color-border)] px-3 text-base"
            />
          )}

          <div className="mb-3 flex gap-2">
            <input
              ref={amountRef}
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onAmountEntered();
                }
              }}
              inputMode="decimal"
              placeholder={formatMoney(outstanding, 'GHS', { withSymbol: false })}
              aria-label="Amount tendered"
              className="h-14 flex-1 rounded-lg border border-[color:var(--color-border)] px-4 text-lg tabular-nums"
            />
            <Button size="lg" onClick={onAmountEntered}>
              Add
            </Button>
          </div>

          {quickAmounts.length > 0 && method === 'CASH' && (
            <div className="mb-4 flex flex-wrap gap-2">
              {quickAmounts.map((amount) => (
                <Button
                  key={amount}
                  variant="secondary"
                  onClick={() => addTender(amount)}
                  className="tabular-nums"
                >
                  {formatMoney(amount)}
                </Button>
              ))}
            </div>
          )}

          {tenders.length > 0 && (
            <ul className="mb-4 divide-y divide-[color:var(--color-border)] rounded-lg border border-[color:var(--color-border)]">
              {tenders.map((tender, index) => (
                <li key={index} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span>
                    {METHODS.find((m) => m.key === tender.method)?.label}
                    {tender.reference && (
                      <span className="ml-2 text-xs text-[color:var(--color-ink-muted)]">
                        {tender.reference}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="font-medium tabular-nums">{formatMoney(tender.amount)}</span>
                    <button
                      type="button"
                      aria-label="Remove this payment"
                      onClick={() => setTenders((c) => c.filter((_, i) => i !== index))}
                      className="text-xs text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-danger)]"
                    >
                      Remove
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <dl className="space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-[color:var(--color-ink-muted)]">Received</dt>
              <dd className="font-medium tabular-nums">{formatMoney(paid)}</dd>
            </div>
            {outstanding > 0 ? (
              <div className="flex justify-between">
                <dt className="text-[color:var(--color-ink-muted)]">Outstanding</dt>
                <dd className="font-semibold tabular-nums text-[color:var(--color-danger)]">
                  {formatMoney(outstanding)}
                </dd>
              </div>
            ) : (
              <div className="flex items-baseline justify-between">
                <dt className="text-[color:var(--color-ink-muted)]">Change</dt>
                <dd className="text-2xl font-semibold tabular-nums text-[color:var(--color-positive)]">
                  {formatMoney(change)}
                </dd>
              </div>
            )}
          </dl>
        </div>

        <footer className="flex gap-2 border-t border-[color:var(--color-border)] px-5 py-4">
          <Button variant="secondary" size="lg" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button
            size="lg"
            block
            loading={submitting}
            disabled={paid < total}
            onClick={() => void confirm()}
          >
            Complete sale
          </Button>
        </footer>
      </div>
    </div>
  );
}
