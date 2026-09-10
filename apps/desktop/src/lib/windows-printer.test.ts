import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]): Promise<unknown> => invoke(...args) as Promise<unknown>,
}));

const { WindowsReceiptPrinter, listPrinters } = await import('./windows-printer');

/**
 * The Windows printer adapter.
 *
 * No printer has been connected to this system, so these tests assert what can be known
 * without one: that the bytes the domain generated are the bytes handed to the transport,
 * that the selected printer is honoured, and that a failure is reported rather than
 * swallowed.
 *
 * What they cannot establish is whether paper comes out. That needs a printer.
 */
describe('WindowsReceiptPrinter', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  const lines = ['ADOM STORES', 'TOTAL   GHS 185.00', 'Thank you'];

  it('sends the receipt to the selected printer', async () => {
    invoke.mockResolvedValue(undefined);
    const printer = new WindowsReceiptPrinter(() => 'Thermal-80mm');

    const result = await printer.print(lines);

    expect(result.ok).toBe(true);
    const [command, args] = invoke.mock.calls[0]!;
    expect(command).toBe('print_raw');
    expect((args as { printerName: string }).printerName).toBe('Thermal-80mm');
  });

  it('sends the bytes the domain generated, not its own', async () => {
    // The layout is decided once, in the domain, and shared with the on-screen copy. A
    // printer that formatted its own receipt would be a second definition of what a
    // customer was charged.
    invoke.mockResolvedValue(undefined);
    await new WindowsReceiptPrinter(() => 'P').print(lines);

    const bytes = (invoke.mock.calls[0]![1] as { bytes: number[] }).bytes;
    expect(bytes.slice(0, 2)).toEqual([0x1b, 0x40]); // initialise
    const text = String.fromCharCode(...bytes.filter((b) => b >= 0x20 && b <= 0x7e));
    expect(text).toContain('ADOM STORES');
    expect(text).toContain('185.00');
    expect(bytes.slice(-3, -1)).toEqual([0x1d, 0x56]); // cut
  });

  it('honours a printer changed in settings without being rebuilt', async () => {
    invoke.mockResolvedValue(undefined);
    let selected = 'First';
    const printer = new WindowsReceiptPrinter(() => selected);

    await printer.print(lines);
    selected = 'Second';
    await printer.print(lines);

    expect((invoke.mock.calls[0]![1] as { printerName: string }).printerName).toBe('First');
    expect((invoke.mock.calls[1]![1] as { printerName: string }).printerName).toBe('Second');
  });

  describe('when it cannot print', () => {
    it('refuses before invoking anything if no printer is selected', async () => {
      const result = await new WindowsReceiptPrinter(() => '').print(lines);
      expect(result).toEqual({ ok: false, failure: 'NO_PRINTER' });
      expect(invoke).not.toHaveBeenCalled();
    });

    it('reports a failure rather than throwing', async () => {
      // A thrown printer error inside the sale path is how a completed sale gets rolled
      // back for a paper jam.
      invoke.mockRejectedValue(new Error('Could not open printer: element not found'));
      const result = await new WindowsReceiptPrinter(() => 'P').print(lines);
      expect(result.ok).toBe(false);
      expect(result.failure).toBe('OFFLINE');
    });

    it('recognises out of paper', async () => {
      invoke.mockRejectedValue(new Error('The printer is out of paper'));
      expect((await new WindowsReceiptPrinter(() => 'P').print(lines)).failure).toBe(
        'OUT_OF_PAPER',
      );
    });

    it('reports an unknown failure as FAILED rather than guessing', async () => {
      invoke.mockRejectedValue(new Error('0x8007007B'));
      expect((await new WindowsReceiptPrinter(() => 'P').print(lines)).failure).toBe('FAILED');
    });

    it('can be retried after a failure', async () => {
      invoke.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
      const printer = new WindowsReceiptPrinter(() => 'P');
      expect((await printer.print(lines)).ok).toBe(false);
      expect((await printer.print(lines)).ok).toBe(true);
    });
  });

  describe('the cash drawer', () => {
    it('fires through the printer, because that is how it is wired', async () => {
      invoke.mockResolvedValue(undefined);
      await new WindowsReceiptPrinter(() => 'P').openDrawer();

      const [command, args] = invoke.mock.calls[0]!;
      expect(command).toBe('print_raw');
      const bytes = (args as { bytes: number[] }).bytes;
      // ESC p — the drawer kick.
      expect(bytes).toContain(0x70);
      expect(bytes.slice(0, 2)).toEqual([0x1b, 0x40]);
    });

    it('uses the configured drawer pin', async () => {
      invoke.mockResolvedValue(undefined);
      await new WindowsReceiptPrinter(() => 'P', { drawerPin: 1 }).openDrawer();
      const bytes = (invoke.mock.calls[0]![1] as { bytes: number[] }).bytes;
      const kick = bytes.indexOf(0x70);
      expect(bytes[kick + 1]).toBe(1);
    });

    it('reports a transport failure rather than claiming the drawer opened', async () => {
      // Windows cannot observe a solenoid. Success means the pulse was sent, and nothing
      // in this layer is allowed to imply more.
      invoke.mockRejectedValue(new Error('printer offline'));
      const result = await new WindowsReceiptPrinter(() => 'P').openDrawer();
      expect(result.ok).toBe(false);
    });

    it('does not fire a drawer when no printer is selected', async () => {
      const result = await new WindowsReceiptPrinter(() => '').openDrawer();
      expect(result).toEqual({ ok: false, failure: 'NO_PRINTER' });
      expect(invoke).not.toHaveBeenCalled();
    });
  });

  describe('listing printers', () => {
    it('maps what Windows reports', async () => {
      invoke.mockResolvedValue([
        { name: 'Thermal-80mm', is_default: true },
        { name: 'Office Laser', is_default: false },
      ]);
      const printers = await listPrinters();
      expect(printers).toEqual([
        { name: 'Thermal-80mm', isDefault: true },
        { name: 'Office Laser', isDefault: false },
      ]);
    });

    it('treats no printers as an ordinary state, not an error', async () => {
      invoke.mockRejectedValue(new Error('Printing is only supported on Windows.'));
      await expect(listPrinters()).resolves.toEqual([]);
    });
  });

  describe('status', () => {
    it('is offline when the selected printer is not in the spooler list', async () => {
      invoke.mockResolvedValue([{ name: 'Some Other', is_default: true }]);
      const result = await new WindowsReceiptPrinter(() => 'Thermal-80mm').status();
      expect(result).toEqual({ ok: false, failure: 'OFFLINE' });
    });

    it('is ok when the printer is present', async () => {
      invoke.mockResolvedValue([{ name: 'Thermal-80mm', is_default: true }]);
      expect((await new WindowsReceiptPrinter(() => 'Thermal-80mm').status()).ok).toBe(true);
    });
  });
});
