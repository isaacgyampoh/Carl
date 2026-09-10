import { describe, expect, it } from 'vitest';

import {
  align,
  cut,
  drawerCommands,
  emphasis,
  initialize,
  line,
  openDrawer,
  receiptCommands,
  toPrintableAscii,
} from './escpos';
import { noPrinter, printFailureMessage, printWithoutFailingTheSale } from './receipt-printer';

/**
 * ESC/POS command generation.
 *
 * No printer has ever been connected to this system, so these tests assert the bytes are
 * right — which is the part that can be known without one. Whether a particular printer
 * honours them remains untested and is documented as such.
 */
describe('ESC/POS commands', () => {
  const hex = (bytes: readonly number[]) =>
    bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');

  it('initialises the printer', () => {
    expect(hex(initialize())).toBe('1b 40');
  });

  it('sets alignment', () => {
    expect(hex(align('left'))).toBe('1b 61 00');
    expect(hex(align('center'))).toBe('1b 61 01');
    expect(hex(align('right'))).toBe('1b 61 02');
  });

  it('turns emphasis on and off again', () => {
    // A receipt that never returns to normal prints everything after the total in double
    // height, and runs off the side of the paper.
    expect(hex(emphasis(true))).toBe('1b 21 30');
    expect(hex(emphasis(false))).toBe('1b 21 00');
  });

  describe('cutting', () => {
    it('feeds before it cuts', () => {
      // The blade sits above the print head. Cutting without feeding takes the last few
      // lines of the receipt with it — including, on a short receipt, the total.
      const bytes = cut();
      expect(bytes.slice(0, 4)).toEqual([0x0a, 0x0a, 0x0a, 0x0a]);
    });

    it('defaults to a partial cut', () => {
      // Leaves a tab so the receipt does not fall on the floor before the customer takes it.
      expect(hex(cut())).toContain('1d 56 01');
      expect(hex(cut(false))).toContain('1d 56 00');
    });
  });

  describe('the cash drawer', () => {
    it('fires pin 0 by default', () => {
      expect(openDrawer().slice(0, 3)).toEqual([0x1b, 0x70, 0x00]);
    });

    it('can fire pin 1, because some drawers are wired that way', () => {
      expect(openDrawer(1).slice(0, 3)).toEqual([0x1b, 0x70, 0x01]);
    });

    it('sends the pulse in 2ms units, as the protocol expects', () => {
      // 50ms on, 200ms off → 25 and 100. Sending milliseconds directly would ask the
      // solenoid to hold for half a second.
      expect(openDrawer(0, 50, 200)).toEqual([0x1b, 0x70, 0x00, 25, 100]);
    });

    it('never exceeds a byte, however long a pulse is asked for', () => {
      // A solenoid held energised gets hot, and the drawer is somebody's property. The
      // protocol cannot express more than 510ms anyway.
      const bytes = openDrawer(0, 100_000, 100_000);
      expect(bytes[3]).toBeLessThanOrEqual(255);
      expect(bytes[4]).toBeLessThanOrEqual(255);
    });
  });

  describe('text a thermal printer can actually render', () => {
    it('spells the cedi rather than printing a box', () => {
      // GH₵12.50 on a CP437 printer comes out as garbage, and a customer holding an
      // unreadable price is worse than one holding a plain one.
      // "GHC12.50", not "GHGHS12.50": the sign follows GH, so the ISO code would duplicate
      // the prefix. Standalone symbols that do not have that convention get the ISO code.
      expect(toPrintableAscii('GH₵12.50')).toBe('GHC12.50');
      expect(toPrintableAscii('₦500')).toBe('NGN500');
    });

    it('flattens the punctuation that arrives in copied product names', () => {
      expect(toPrintableAscii('“Fanta” – 500ml')).toBe('"Fanta" - 500ml');
      expect(toPrintableAscii('Don’t')).toBe("Don't");
    });

    it('strips accents rather than replacing the whole letter', () => {
      // "Cafe" is readable. "Caf?" invites a question at the counter.
      expect(toPrintableAscii('Café Noir')).toBe('Cafe Noir');
    });

    it('replaces anything else it cannot print', () => {
      expect(toPrintableAscii('Rice 🍚')).toContain('?');
      expect(toPrintableAscii('Rice 🍚')).toContain('Rice');
    });

    it('leaves ordinary text alone', () => {
      const plain = 'ADOM STORES  MAIN-20260301-0042  GHS 185.00';
      expect(toPrintableAscii(plain)).toBe(plain);
    });

    it('encodes a line with a trailing feed', () => {
      expect(line('AB')).toEqual([0x41, 0x42, 0x0a]);
    });
  });

  describe('a whole receipt', () => {
    const lines = ['ADOM STORES', 'TOTAL   GHS 185.00', 'Thank you'];

    it('initialises, prints every line, then cuts', () => {
      const bytes = receiptCommands(lines);
      expect(bytes.slice(0, 2)).toEqual([0x1b, 0x40]);
      const text = String.fromCharCode(...bytes.filter((b) => b >= 0x20 && b <= 0x7e));
      expect(text).toContain('ADOM STORES');
      expect(text).toContain('TOTAL');
      expect(bytes.slice(-3, -1)).toEqual([0x1d, 0x56]);
    });

    it('can skip the cut for a printer without a cutter', () => {
      const bytes = receiptCommands(lines, { cutPaper: false });
      expect(bytes).not.toContain(0x56);
    });

    it('opens the drawer only when asked', () => {
      expect(receiptCommands(lines).slice(-2)).not.toEqual([25, 100]);
      const withDrawer = receiptCommands(lines, { openDrawerAfter: true });
      expect(withDrawer.slice(-5, -2)).toEqual([0x1b, 0x70, 0x00]);
    });

    it('cuts before firing the drawer', () => {
      // Otherwise the drawer opens while the paper is still moving, and the cashier
      // reaches past a receipt that is still being printed.
      const bytes = receiptCommands(lines, { openDrawerAfter: true });
      const cutAt = bytes.findIndex((b, i) => b === 0x1d && bytes[i + 1] === 0x56);
      const drawerAt = bytes.findIndex((b, i) => b === 0x1b && bytes[i + 1] === 0x70);
      expect(cutAt).toBeGreaterThan(-1);
      expect(drawerAt).toBeGreaterThan(cutAt);
    });

    it('transliterates the receipt it is given', () => {
      const bytes = receiptCommands(['TOTAL GH₵185.00']);
      expect(bytes.every((b) => b <= 0x7f)).toBe(true);
    });

    it('opens the drawer on its own between sales', () => {
      expect(drawerCommands().slice(0, 2)).toEqual([0x1b, 0x40]);
      expect(drawerCommands(1)).toContain(0x70);
    });
  });
});

describe('when there is no printer', () => {
  it('says so rather than pretending to have printed', async () => {
    // A sale that silently prints nothing is worse than one that reports the failure: the
    // cashier finds out at the counter either way, but only one tells them why.
    const result = await noPrinter.print(['x']);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('NO_PRINTER');
  });

  it('gives the cashier something they can act on', () => {
    expect(printFailureMessage('OUT_OF_PAPER')).toBe('The receipt printer is out of paper.');
    expect(printFailureMessage('NO_PRINTER')).toBe('No receipt printer is set up.');
    // Nothing a person cannot act on: no codes, no device names, no stack.
    for (const failure of [
      'NO_PRINTER',
      'OFFLINE',
      'OUT_OF_PAPER',
      'COVER_OPEN',
      'UNSUPPORTED',
      'FAILED',
    ] as const) {
      expect(printFailureMessage(failure)).not.toMatch(/error|code|0x|undefined/i);
    }
  });

  it('never lets a printer take a sale down with it', async () => {
    // The money has been taken and the sale is recorded. A thrown printer error must not
    // reach the code path that completes it.
    const exploding = {
      ...noPrinter,
      print: () => Promise.reject(new Error('USB device disappeared')),
    };
    const result = await printWithoutFailingTheSale(exploding, ['x']);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('FAILED');
  });
});
