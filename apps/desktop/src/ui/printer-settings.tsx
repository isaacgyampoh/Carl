import { useEffect, useState } from 'react';
import { receiptText, type ReceiptData } from '@carl/domain';

import type { Runtime } from '../app';
import { listPrinters, type WindowsPrinterInfo } from '../lib/windows-printer';
import { selectedPrinterName, setPrinterSelection } from '../lib/printer-selection';

/**
 * Choosing the till's receipt printer.
 *
 * Deliberately small: pick one from what Windows already knows about, and print a test
 * receipt to confirm it is the right physical device. Anything more — driver management,
 * paper widths, codepages — is configuration the shop already did when they installed the
 * printer, and repeating it here is a second place for it to be wrong.
 *
 * A test print is the only honest way to confirm the choice. Windows will happily accept a
 * job for the wrong printer in the back office.
 */
export function PrinterSettings({
  runtime,
  tenantName,
  branchName,
  currencyCode,
  onClose,
}: {
  runtime: Runtime;
  tenantName: string;
  branchName: string;
  currencyCode: string;
  onClose: () => void;
}): React.JSX.Element {
  const [printers, setPrinters] = useState<WindowsPrinterInfo[] | null>(null);
  const [selected, setSelected] = useState(selectedPrinterName());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void listPrinters().then(setPrinters);
  }, []);

  async function choose(name: string): Promise<void> {
    setSelected(name);
    setMessage(null);
    try {
      await setPrinterSelection(runtime.connection, name);
    } catch {
      /*
       * The selection is held in memory as well as on disk, so the choice works for this
       * shift either way. What fails silently otherwise is the *next* shift: the till comes
       * back tomorrow having forgotten its printer, receipts stop, and nobody connects that
       * to a settings screen used once yesterday.
       *
       * The promise was previously discarded with `void`, so this failure produced an
       * unhandled rejection in a WebView, which is to say nothing at all.
       */
      setMessage(
        'That printer is selected for now, but it could not be saved — the till will forget it ' +
          'when it restarts. Choose it again after restarting, and tell whoever supports this ' +
          'machine.',
      );
    }
  }

  async function testPrint(): Promise<void> {
    if (!runtime.printer) return;
    setBusy(true);
    setMessage(null);

    const sample: ReceiptData = {
      businessName: tenantName,
      branchName,
      saleNumber: 'TEST',
      soldAt: new Date(),
      cashierName: 'Test print',
      lines: [{ name: 'Test item', quantity: 1000, unitPrice: 100, lineTotal: 100 }],
      subtotal: 100,
      discountTotal: 0,
      taxTotal: 0,
      total: 100,
      payments: [{ method: 'CASH', amount: 100 }],
      amountPaid: 100,
      changeGiven: 0,
      currencyCode: `${currencyCode} `,
      footer: 'Printer test — not a real sale',
    };

    const result = await runtime.printer
      .print(receiptText(sample, 32).split('\n'))
      .finally(() => setBusy(false));
    // "Sent" rather than "printed": Windows confirms the spooler took the job, not that
    // paper came out. Saying otherwise sends a cashier looking for a receipt that is not
    // there without telling them why.
    setMessage(
      result.ok
        ? 'Sent to the printer. Check that a receipt came out.'
        : 'The printer did not accept the test. Check that it is on and connected.',
    );
  }

  async function testDrawer(): Promise<void> {
    if (!runtime.printer) return;
    setBusy(true);
    setMessage(null);
    // `finally`, so an unexpected throw cannot leave both buttons disabled with no way back
    // except closing the screen.
    const result = await runtime.printer.openDrawer().finally(() => setBusy(false));
    setMessage(
      result.ok
        ? 'Drawer signal sent through the printer.'
        : 'The drawer signal could not be sent.',
    );
  }

  return (
    <main className="settings">
      <header className="settings__header">
        <h1>Receipt printer</h1>
        <button onClick={onClose}>Close</button>
      </header>

      {printers === null ? (
        <p className="settings__hint">Looking for printers…</p>
      ) : printers.length === 0 ? (
        <p className="settings__hint">
          Windows reports no printers on this machine. Install the receipt printer in Windows first
          — Carl uses whatever Windows already knows about. The till sells normally without one.
        </p>
      ) : (
        <ul className="settings__list">
          {printers.map((printer) => (
            <li key={printer.name}>
              <label className="settings__row">
                <input
                  type="radio"
                  name="printer"
                  checked={selected === printer.name}
                  onChange={() => void choose(printer.name)}
                />
                <span>
                  {printer.name}
                  {printer.isDefault ? <em> — Windows default</em> : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <div className="settings__actions">
        <button onClick={() => void testPrint()} disabled={busy || !selected}>
          Test print
        </button>
        <button onClick={() => void testDrawer()} disabled={busy || !selected}>
          Test cash drawer
        </button>
      </div>

      {message ? (
        <p className="settings__hint" role="status">
          {message}
        </p>
      ) : null}
    </main>
  );
}
