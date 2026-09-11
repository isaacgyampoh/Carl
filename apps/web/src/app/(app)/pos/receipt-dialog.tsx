'use client';

import { useEffect, useRef } from 'react';
import { formatMoney } from '@carl/shared';
import type { ReceiptData } from '@carl/domain';
import { Button } from '@carl/ui';

import { PrintableReceipt, ShareReceiptButton } from '@/components/receipt';

/**
 * Confirmation after a completed sale.
 *
 * Shows the change due at a size readable across a counter, and closes on any key so the
 * cashier can carry straight on to the next customer without reaching for the mouse.
 *
 * Thermal printing arrives with the desktop application, which can talk to a printer
 * directly. In the browser this offers the print dialog, which is what a shop with a
 * receipt printer attached to a laptop actually uses — and, for a shop with no printer at
 * all, sending the receipt to the customer's phone.
 */
export function ReceiptDialog({
  receipt,
  printData,
  branchName,
  cashierName,
  onClose,
}: {
  receipt: { saleNumber: string; total: number; paid: number; change: number };
  /** The full receipt, printed by the Print button: items, payments, business details. */
  printData: ReceiptData;
  branchName: string;
  cashierName: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      // Any key dismisses. After a sale the cashier's next action is always the next
      // customer, so anything that requires aiming at a button costs time.
      if (event.key === 'Enter' || event.key === 'Escape' || event.key === ' ') {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Sale completed"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
    >
      <PrintableReceipt data={printData} />
      <div className="w-full max-w-sm rounded-2xl bg-[color:var(--color-surface)] p-6 text-center">
        <p className="text-sm font-medium text-[color:var(--color-positive)]">Sale completed</p>
        <p className="mt-1 font-mono text-sm text-[color:var(--color-ink-muted)]">
          {receipt.saleNumber}
        </p>

        {receipt.change > 0 && (
          <div className="my-5 rounded-lg bg-[color:var(--color-surface-muted)] py-4">
            <p className="text-sm text-[color:var(--color-ink-muted)]">Change due</p>
            <p className="text-4xl font-semibold tabular-nums tracking-tight">
              {formatMoney(receipt.change)}
            </p>
          </div>
        )}

        <dl className="my-4 space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-[color:var(--color-ink-muted)]">Total</dt>
            <dd className="font-medium tabular-nums">{formatMoney(receipt.total)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[color:var(--color-ink-muted)]">Received</dt>
            <dd className="font-medium tabular-nums">{formatMoney(receipt.paid)}</dd>
          </div>
        </dl>

        <p className="mb-4 text-xs text-[color:var(--color-ink-muted)]">
          {branchName} · {cashierName}
        </p>

        <div className="flex gap-2">
          <Button variant="secondary" size="lg" block onClick={() => window.print()}>
            Print
          </Button>
          <Button ref={closeRef} size="lg" block onClick={onClose}>
            Next sale
          </Button>
        </div>

        <div className="mt-2 flex flex-col items-center">
          <ShareReceiptButton
            receipt={{ ...printData, soldAt: printData.soldAt.toISOString() }}
            size="lg"
          />
        </div>
      </div>
    </div>
  );
}
