'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatMoney, newIdempotencyKey } from '@carl/shared';
import { Alert, Button, Card, CardBody, CardHeader, Field } from '@carl/ui';

import { processReturn, voidSale } from '@/server/pos-actions';

interface ReturnableItem {
  id: string;
  name: string;
  available: number;
  unitPrice: number;
}

/**
 * Returning and voiding.
 *
 * The two are presented separately and worded carefully, because staff conflate them and
 * the consequences differ: a void erases a sale that should not have happened, while a
 * return leaves the original sale in the day's takings as a later, separate event.
 */
export function SaleActions({
  saleId,
  items,
  canRefund,
  canVoid,
}: {
  saleId: string;
  items: ReturnableItem[];
  canRefund: boolean;
  canVoid: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'none' | 'return' | 'void'>('none');
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [refundMethod, setRefundMethod] = useState<'CASH' | 'MOMO' | 'NONE'>('CASH');
  const [refundReference, setRefundReference] = useState('');
  const [restocked, setRestocked] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = Object.entries(quantities).filter(([, quantity]) => quantity > 0);
  const refundTotal = selected.reduce((sum, [id, quantity]) => {
    const item = items.find((candidate) => candidate.id === id);
    return sum + (item ? item.unitPrice * quantity : 0);
  }, 0);

  async function submitReturn(): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await processReturn({
      saleId,
      items: selected.map(([id, quantity]) => ({
        sale_item_id: id,
        quantity,
        condition: restocked ? 'RESALEABLE' : 'DAMAGED',
      })),
      reason,
      // Generated once for this logical return, not per attempt.
      idempotencyKey: newIdempotencyKey(),
      ...(refundMethod !== 'NONE' ? { refundMethod } : {}),
      ...(refundReference.trim() ? { refundReference: refundReference.trim() } : {}),
      restocked,
    });

    if (!result.ok) {
      setError(result.message);
      setBusy(false);
      return;
    }
    setMode('none');
    setBusy(false);
    router.refresh();
  }

  async function submitVoid(): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await voidSale({ saleId, reason });
    if (!result.ok) {
      setError(result.message);
      setBusy(false);
      return;
    }
    setMode('none');
    setBusy(false);
    router.refresh();
  }

  if (!canRefund && !canVoid) return null;

  return (
    <Card>
      <CardHeader title="Actions" />
      <CardBody className="flex flex-col gap-3">
        {error && <Alert tone="danger">{error}</Alert>}

        {mode === 'none' && (
          <>
            {canRefund && items.length > 0 && (
              <Button variant="secondary" block onClick={() => setMode('return')}>
                Return items
              </Button>
            )}
            {canVoid && (
              <Button variant="ghost" block onClick={() => setMode('void')}>
                Void this sale
              </Button>
            )}
            <p className="text-xs text-[color:var(--color-ink-muted)]">
              Void cancels a sale that should not have happened. Return records goods coming back,
              and leaves the original sale in the day&apos;s takings.
            </p>
          </>
        )}

        {mode === 'return' && (
          <>
            <ul className="flex flex-col gap-2">
              {items.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">{item.name}</span>
                  <input
                    type="number"
                    min={0}
                    max={item.available}
                    step="any"
                    value={quantities[item.id] ?? 0}
                    onChange={(event) =>
                      setQuantities((current) => ({
                        ...current,
                        [item.id]: Math.min(Number(event.target.value), item.available),
                      }))
                    }
                    aria-label={`Quantity of ${item.name} to return`}
                    className="h-9 w-20 rounded-md border border-[color:var(--color-border)] px-2 text-right tabular-nums"
                  />
                </li>
              ))}
            </ul>

            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-5 shrink-0 accent-[color:var(--color-brand)]"
                checked={restocked}
                onChange={(event) => setRestocked(event.target.checked)}
              />
              Goods are resaleable and go back into stock
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Refund method</span>
              <select
                value={refundMethod}
                onChange={(event) =>
                  setRefundMethod(event.target.value as 'CASH' | 'MOMO' | 'NONE')
                }
                className="h-10 rounded-lg border border-[color:var(--color-border)] px-3"
              >
                <option value="CASH">Cash</option>
                <option value="MOMO">Mobile money</option>
                <option value="NONE">No refund (exchange)</option>
              </select>
            </label>

            {refundMethod === 'MOMO' && (
              <Field
                label="Transfer reference"
                value={refundReference}
                onChange={(event) => setRefundReference(event.target.value)}
                hint="Required, so the refund can be reconciled against the phone."
              />
            )}

            <Field
              label="Reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why is this being returned?"
              required
            />

            {refundTotal > 0 && refundMethod !== 'NONE' && (
              <p className="text-sm">
                Refund <strong className="tabular-nums">{formatMoney(refundTotal)}</strong>
              </p>
            )}

            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setMode('none')} disabled={busy}>
                Cancel
              </Button>
              <Button
                block
                loading={busy}
                disabled={selected.length === 0 || reason.trim().length < 3}
                onClick={() => void submitReturn()}
              >
                Record return
              </Button>
            </div>
          </>
        )}

        {mode === 'void' && (
          <>
            <Alert tone="warning">
              Voiding restores the stock and removes this sale from the day&apos;s takings. Use a
              return instead if the customer is bringing goods back.
            </Alert>
            <Field
              label="Reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why is this being voided?"
              required
            />
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setMode('none')} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="danger"
                block
                loading={busy}
                disabled={reason.trim().length < 3}
                onClick={() => void submitVoid()}
              >
                Void sale
              </Button>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
