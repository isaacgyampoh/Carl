/**
 * The Windows end of the printer port.
 *
 * ## Where this sits
 *
 *   POS → ReceiptPrinter (port, @carl/domain)
 *       → WindowsReceiptPrinter (this file)
 *       → Tauri command → Windows print spooler → thermal printer
 *
 * Nothing above the port knows a printer exists on Windows, or that ESC/POS is involved.
 * This file is the only place that knows both.
 *
 * ## What "success" means here
 *
 * The spooler accepting a job is not paper coming out, and Windows does not report the
 * difference. Every message this produces says "sent to the printer", never "printed" —
 * a cashier who is told a receipt printed and finds none is worse off than one who is told
 * it was sent and can check.
 */

import { invoke } from '@tauri-apps/api/core';
import {
  drawerCommands,
  receiptCommands,
  type PrintFailure,
  type PrintResult,
  type ReceiptPrinter,
} from '@carl/domain';

export interface WindowsPrinterInfo {
  readonly name: string;
  readonly isDefault: boolean;
}

/** The printers Windows knows about. Empty is an ordinary state, not an error. */
export async function listPrinters(): Promise<WindowsPrinterInfo[]> {
  try {
    const printers = await invoke<{ name: string; is_default: boolean }[]>('list_printers');
    return printers.map((p) => ({ name: p.name, isDefault: p.is_default }));
  } catch {
    // A machine with no print subsystem at all, or a non-Windows build.
    return [];
  }
}

/**
 * Maps a transport error onto something a cashier can act on.
 *
 * Deliberately coarse. Windows reports a great many distinct printer errors and almost
 * none of them mean anything at a counter; what matters is whether to check the paper, the
 * power, or the settings.
 */
function classify(message: string): PrintFailure {
  const text = message.toLowerCase();
  if (text.includes('no printer selected')) return 'NO_PRINTER';
  if (text.includes('only supported on windows')) return 'UNSUPPORTED';
  if (text.includes('paper')) return 'OUT_OF_PAPER';
  /*
   * Checked before the cover, deliberately. "Could not open printer" contains the word
   * "open", and a looser cover test matched it — telling a cashier to close a cover that
   * was never open while the real problem was a printer that had gone away.
   */
  if (text.includes('could not open printer') || text.includes('offline')) return 'OFFLINE';
  if (text.includes('cover')) return 'COVER_OPEN';
  return 'FAILED';
}

async function send(printerName: string, bytes: number[]): Promise<PrintResult> {
  if (!printerName) return { ok: false, failure: 'NO_PRINTER' };
  try {
    await invoke('print_raw', { printerName, bytes });
    return { ok: true };
  } catch (error) {
    return { ok: false, failure: classify(error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * A receipt printer reached through the Windows spooler.
 *
 * The printer name is supplied by a function rather than captured, so changing the selected
 * printer in settings takes effect on the next sale without rebuilding anything holding a
 * reference to this object.
 */
export class WindowsReceiptPrinter implements ReceiptPrinter {
  constructor(
    private readonly printerName: () => string,
    private readonly options: { cutPaper?: boolean; drawerPin?: 0 | 1 } = {},
  ) {}

  print(lines: readonly string[]): Promise<PrintResult> {
    return send(
      this.printerName(),
      receiptCommands(lines, { cutPaper: this.options.cutPaper !== false }),
    );
  }

  openDrawer(): Promise<PrintResult> {
    /*
     * The drawer is fired through the printer, because that is how it is wired: a solenoid
     * on the printer's RJ11 port. Success here means the pulse command reached the spooler.
     * Whether the drawer physically opened is not something Windows can tell us, and this
     * does not claim it.
     */
    return send(this.printerName(), drawerCommands(this.options.drawerPin ?? 0));
  }

  async status(): Promise<PrintResult> {
    const name = this.printerName();
    if (!name) return { ok: false, failure: 'NO_PRINTER' };
    const printers = await listPrinters();
    // Present in the spooler's list is the most Windows will tell us without printing.
    return printers.some((p) => p.name === name) ? { ok: true } : { ok: false, failure: 'OFFLINE' };
  }
}
