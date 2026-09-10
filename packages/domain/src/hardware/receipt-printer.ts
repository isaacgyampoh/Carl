/**
 * The printer port.
 *
 * ## Why an interface rather than a driver
 *
 * A shop buys whatever thermal printer the local supplier had in stock that week. Carl
 * cannot know which, and the POS must not care: completing a sale is business logic, and
 * "which escape sequence cuts the paper" is not. Nothing above this line mentions a brand,
 * a port, or a byte.
 *
 * ## What is deliberately NOT here
 *
 * Transport. Opening a USB device, a serial port or a TCP socket needs the operating
 * system, and a browser cannot do any of it — so the adapter that actually moves bytes
 * lives in the desktop application, where Tauri can reach the hardware.
 *
 * That adapter does not exist yet, and no printer has ever been connected to this system.
 * What exists is everything that can be built and tested without one: the commands, the
 * layout, and the failure handling.
 */

/** How a printed receipt can fail, from the caller's point of view. */
export type PrintFailure =
  | 'NO_PRINTER' // none configured, or the configured one is gone
  | 'OFFLINE' // configured but not answering
  | 'OUT_OF_PAPER'
  | 'COVER_OPEN'
  | 'UNSUPPORTED' // the adapter cannot do what was asked
  | 'FAILED'; // anything else; the detail belongs in a log, not on a screen

export interface PrintResult {
  readonly ok: boolean;
  readonly failure?: PrintFailure;
}

export interface ReceiptPrinter {
  /**
   * Prints one receipt.
   *
   * Takes rendered lines rather than a sale, so the printer layer never computes a total.
   * The figures a customer holds must be the ones the server agreed to.
   */
  print(lines: readonly string[]): Promise<PrintResult>;

  /**
   * Opens the cash drawer.
   *
   * On the port because that is physically where it lives: nearly every POS drawer is a
   * solenoid wired to the printer's RJ11 socket and fired by a printer command. A separate
   * "drawer device" would be a fiction about the hardware.
   */
  openDrawer(): Promise<PrintResult>;

  /** Whether printing is currently possible, for showing state before a cashier tries. */
  status(): Promise<PrintResult>;
}

/**
 * A printer that does nothing and says so.
 *
 * Used wherever no printer is configured — which is every installation today. It reports
 * NO_PRINTER rather than pretending to succeed, because a sale that silently prints
 * nothing is worse than one that says the receipt could not be printed: the cashier finds
 * out at the counter either way, but only one of them tells them why.
 */
export const noPrinter: ReceiptPrinter = {
  print: () => Promise.resolve({ ok: false, failure: 'NO_PRINTER' }),
  openDrawer: () => Promise.resolve({ ok: false, failure: 'NO_PRINTER' }),
  status: () => Promise.resolve({ ok: false, failure: 'NO_PRINTER' }),
};

/**
 * What a cashier should be told.
 *
 * Deliberately short and free of jargon. "Out of paper" is something a person can act on;
 * a device error code is not.
 */
export function printFailureMessage(failure: PrintFailure): string {
  switch (failure) {
    case 'NO_PRINTER':
      return 'No receipt printer is set up.';
    case 'OFFLINE':
      return 'The receipt printer is not responding. Check that it is on.';
    case 'OUT_OF_PAPER':
      return 'The receipt printer is out of paper.';
    case 'COVER_OPEN':
      return 'The receipt printer cover is open.';
    case 'UNSUPPORTED':
      return 'This printer cannot print receipts.';
    case 'FAILED':
      return 'The receipt could not be printed.';
  }
}

/**
 * A sale is complete whether or not the paper came out.
 *
 * The money has been taken and the sale is recorded; a failed receipt is an inconvenience,
 * not a reason to fail the transaction or to leave the cashier unsure whether it went
 * through. This helper exists so no caller is tempted to `await print()` inside the path
 * that completes a sale.
 */
export async function printWithoutFailingTheSale(
  printer: ReceiptPrinter,
  lines: readonly string[],
): Promise<PrintResult> {
  try {
    return await printer.print(lines);
  } catch {
    return { ok: false, failure: 'FAILED' };
  }
}
