/**
 * Taking the money.
 *
 * ## The one rule
 *
 * The sale is written to the local queue before this panel reports success, and before a
 * receipt prints. If Carl said "done" and then crashed before writing, a transaction that
 * really happened — for which cash is really in the drawer — would cease to exist.
 *
 * Everything else here is arrangement. This is the part that must not be reordered.
 */

import { useState } from 'react';
import type { SaleItemPayload } from '@carl/domain';

import type { Runtime } from '../app';
import type { DeviceConfig } from '../lib/device-store';

type Method = 'CASH' | 'MOMO' | 'CARD' | 'BANK_TRANSFER';

const METHODS: readonly { value: Method; label: string }[] = [
  { value: 'CASH', label: 'Cash' },
  { value: 'MOMO', label: 'Mobile money' },
  { value: 'CARD', label: 'Card' },
  { value: 'BANK_TRANSFER', label: 'Transfer' },
];

const money = (minor: number, currency: string): string =>
  new Intl.NumberFormat('en-GH', { style: 'currency', currency }).format(minor / 100);

export function PaymentPanel({
  runtime,
  config,
  total,
  payload,
  onCancel,
  onCompleted,
}: {
  runtime: Runtime;
  config: DeviceConfig;
  total: number;
  payload: { items: SaleItemPayload[] };
  onCancel: () => void;
  onCompleted: () => void | Promise<void>;
}): React.JSX.Element {
  const [method, setMethod] = useState<Method>('CASH');
  const [tendered, setTendered] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const given = Math.round(Number(tendered.replace(/[^0-9.]/g, '')) * 100);
  const change = Number.isFinite(given) ? given - total : 0;
  // Cash can be over-tendered and change given. Everything else is paid exactly.
  const enough = method !== 'CASH' || (Number.isFinite(given) && given >= total);

  async function complete(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // Generated once, here, and reused for every retry forever. It is what makes
      // resending safe when a connection dies without saying whether the sale landed.
      const idempotencyKey = crypto.randomUUID();
      // The corrected clock: a till running fast would otherwise stamp a sale in the
      // future, and the server refuses those — after the money was taken.
      const soldAt = (await runtime.devices.now()).toISOString();

      await runtime.queue.enqueue({
        id: idempotencyKey,
        operation: 'complete_sale',
        occurredAt: soldAt,
        payload: {
          branchId: config.branchId,
          items: payload.items,
          // The amount recorded is what the sale costs, not what was handed over. Change
          // is the cashier's arithmetic, not a payment.
          payments: [{ method, amount: total }],
          tier: 'RETAIL',
        },
      } as never);

      // Only now is the cashier told. The sale is on disk.
      await onCompleted();
    } catch (caught) {
      // The sale was NOT recorded. Say so plainly: a cashier who believes a failed sale
      // succeeded hands over goods for nothing.
      setError(
        caught instanceof Error
          ? `The sale was not saved: ${caught.message}`
          : 'The sale was not saved. Do not hand over the goods.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Take payment"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          padding: 24,
          width: 460,
          display: 'grid',
          gap: 18,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 30, fontWeight: 700 }}>
          <span>Total</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {money(total, config.currencyCode)}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {METHODS.map((option) => (
            <button
              key={option.value}
              onClick={() => setMethod(option.value)}
              className={method === option.value ? 'primary' : ''}
              style={{ minHeight: 54 }}
            >
              {option.label}
            </button>
          ))}
        </div>

        {method === 'CASH' ? (
          <div style={{ display: 'grid', gap: 8 }}>
            <label htmlFor="tendered">Cash received</label>
            <input
              id="tendered"
              value={tendered}
              onChange={(event) => setTendered(event.target.value)}
              inputMode="decimal"
              autoFocus
              style={{ fontSize: 24, textAlign: 'right' }}
            />
            {change > 0 ? (
              <p style={{ margin: 0, fontSize: 20 }}>
                Change: <strong>{money(change, config.currencyCode)}</strong>
              </p>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>
            {error}
          </p>
        ) : null}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
          <button onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={() => void complete()} disabled={busy || !enough}>
            {busy ? 'Saving…' : 'Complete sale'}
          </button>
        </div>
      </div>
    </div>
  );
}
