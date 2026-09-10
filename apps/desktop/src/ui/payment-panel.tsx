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
import {
  lineTotals,
  printFailureMessage,
  printWithoutFailingTheSale,
  renderReceipt,
  type CartLine,
  type ReceiptData,
  type ReceiptPrinter,
  type SaleItemPayload,
} from '@carl/domain';

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
  cashierName,
  total,
  subtotal,
  discountTotal,
  taxTotal,
  lines,
  payload,
  printer,
  onCancel,
  onCompleted,
}: {
  runtime: Runtime;
  config: DeviceConfig;
  cashierName: string;
  total: number;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  lines: readonly CartLine[];
  payload: { items: SaleItemPayload[] };
  /** Absent when no printer is configured; the till sells perfectly well without one. */
  printer: ReceiptPrinter | null;
  onCancel: () => void;
  onCompleted: () => void | Promise<void>;
}): React.JSX.Element {
  const [method, setMethod] = useState<Method>('CASH');
  // Surfaced to the cashier after the sale has already succeeded, never instead of it.
  const [printProblem, setPrintProblem] = useState<string | null>(null);
  const [tendered, setTendered] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
   * The sale is on disk and the screen could not be cleared normally. It exists so the
   * Complete button can be taken away: a live button over a sale that has already happened
   * is how a customer gets charged twice.
   */
  const [settled, setSettled] = useState(false);

  const given = Math.round(Number(tendered.replace(/[^0-9.]/g, '')) * 100);
  const change = Number.isFinite(given) ? given - total : 0;
  // Cash can be over-tendered and change given. Everything else is paid exactly.
  const enough = method !== 'CASH' || (Number.isFinite(given) && given >= total);

  async function complete(): Promise<void> {
    setBusy(true);
    setError(null);

    // Generated once, here, and reused for every retry forever. It is what makes
    // resending safe when a connection dies without saying whether the sale landed.
    const idempotencyKey = crypto.randomUUID();
    let soldAt: string;

    /*
     * Part one: getting the sale onto disk. This is the only part that may fail the sale.
     */
    try {
      // The corrected clock: a till running fast would otherwise stamp a sale in the
      // future, and the server refuses those — after the money was taken.
      soldAt = (await runtime.devices.now()).toISOString();

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
    } catch (caught) {
      // The sale was NOT recorded. Say so plainly: a cashier who believes a failed sale
      // succeeded hands over goods for nothing.
      setError(
        caught instanceof Error
          ? `The sale was not saved: ${caught.message}`
          : 'The sale was not saved. Do not hand over the goods.',
      );
      setBusy(false);
      return;
    }

    /*
     * Part two: everything after the money is taken.
     *
     * From this line the sale is on disk. NOTHING below may tell the cashier the sale
     * failed, and nothing below may leave a control that would ring it a second time.
     *
     * This used to sit inside the same `try` as the enqueue above. A failure in any of it —
     * and `onCompleted` refreshes the pending count, which reads SQLite — was reported as
     * "The sale was not saved. Do not hand over the goods." That is a lie told at the worst
     * possible moment: the cashier either withholds goods the customer has paid for, or
     * rings the sale again under a fresh idempotency key and charges them twice.
     */

    /*
     * The receipt, stored against the queued sale.
     *
     * Kept locally so a customer who comes back an hour later can have it reprinted even
     * though the sale has not reached the server. It is marked as not yet synced, because
     * a shop reconciling its day has to be able to tell which receipts represent sales
     * the server has not seen.
     *
     * Failing to store it must not fail the sale: the money has been taken and the sale
     * is already on disk. A missing reprint is an inconvenience; a lost sale is not.
     */
    let receiptLines: string[] = [];
    try {
      const receipt: ReceiptData = {
        businessName: config.tenantName,
        branchName: config.branchName,
        saleNumber: `LOCAL-${idempotencyKey.slice(0, 8).toUpperCase()}`,
        soldAt: new Date(soldAt),
        cashierName,
        /*
         * `lineTotals(line).total`, not `unitPrice * quantity / 1000`.
         *
         * The arithmetic version was floating point and produced a non-integer whenever
         * goods were weighed: 9.99/kg at half a kilo is 499.5 minor units, which the
         * receipt formatter renders by flooring and taking a remainder, printing
         * "GHS 4.99.5" on a customer's copy. 3.33/kg at 0.1 kg printed
         * "GHS 0.33.300000000000004".
         *
         * It also disagreed with the money actually taken, because it skipped the line's
         * discount and tax. `lineTotals` is what the cart charged and what `complete_sale`
         * recomputes on the server, so the lines now sum to the subtotal printed below
         * them.
         */
        lines: lines.map((line) => ({
          name: line.name,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: lineTotals(line).total,
        })),
        subtotal,
        discountTotal,
        taxTotal,
        total,
        payments: [{ method, amount: total }],
        amountPaid: method === 'CASH' ? given : total,
        changeGiven: method === 'CASH' && change > 0 ? change : 0,
        currencyCode: `${config.currencyCode} `,
        pendingSync: true,
      };
      // Rendered once and used twice: stored for reprinting, and sent to the printer.
      // Two renderings would be two chances to disagree about what the customer paid.
      receiptLines = renderReceipt(receipt, 32);
      await runtime.connection.execute(
        `insert into local_receipts (queue_id, receipt_body) values (?, ?)
           on conflict (queue_id) do update set receipt_body = excluded.receipt_body`,
        [idempotencyKey, receiptLines.join('\n')],
      );
    } catch {
      // The sale is safe. A receipt that cannot be stored is not a reason to fail it.
    }

    /*
     * Print, strictly after the sale is on disk and strictly outside the path that
     * decides whether the sale succeeded.
     *
     * A paper jam, an unplugged printer or no printer at all must never roll back money
     * that has been taken. `printWithoutFailingTheSale` swallows the throw; the outcome
     * is surfaced to the cashier so they can retry, and the receipt is already stored
     * for reprinting either way.
     */
    if (printer) {
      const printed = await printWithoutFailingTheSale(printer, receiptLines);
      if (!printed.ok && printed.failure) {
        setPrintProblem(printFailureMessage(printed.failure));
      }
      // The drawer is fired only for cash. A card or mobile-money sale has no change to
      // give, and a drawer that springs open on every sale is a security problem in a
      // busy shop.
      if (method === 'CASH') {
        await printer.openDrawer().catch(() => undefined);
      }
    }

    // Only now is the cashier told. The sale is on disk.
    try {
      await onCompleted();
    } catch {
      /*
       * Tidying up the screen failed. The sale is still saved and the money is still taken,
       * so the cashier is told exactly that and the panel is settled — the Complete button
       * goes away rather than staying live over a sale that has already happened.
       */
      setSettled(true);
    }
    setBusy(false);
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
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 30,
            fontWeight: 700,
          }}
        >
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

        {/* A print problem is a warning, not an error: the sale succeeded and the money is
            recorded. Coloured accordingly, so a cashier does not think the sale failed. */}
        {printProblem ? (
          <p role="status" style={{ color: 'var(--warning)', margin: 0 }}>
            {printProblem} The sale is saved — you can reprint the receipt.
          </p>
        ) : null}

        {settled ? (
          /*
           * The sale is saved; only clearing the screen failed. The cashier is told the
           * money is safe and given a way out that cannot ring the sale again.
           */
          <div>
            <p role="status" style={{ marginBottom: 10 }}>
              This sale is saved. The screen could not be cleared — close this and carry on; do not
              ring it again.
            </p>
            <button className="primary" onClick={onCancel} style={{ width: '100%' }}>
              Close
            </button>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
            <button onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button className="primary" onClick={() => void complete()} disabled={busy || !enough}>
              {busy ? 'Saving…' : 'Complete sale'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
