import { describe, expect, it } from 'vitest';

import { receiptText, renderReceipt, type ReceiptData } from './receipt';

/**
 * The receipt.
 *
 * In Ghana this is routinely the only copy of a transaction either party keeps, so what it
 * says has to be exactly what was charged. Most of these tests are about money appearing
 * correctly and completely — a figure pushed off the edge of the paper is not a cosmetic
 * problem, it is the document failing at its only job.
 */
describe('renderReceipt', () => {
  const base: ReceiptData = {
    businessName: 'Adom Stores',
    branchName: 'Main Branch',
    phone: '0244 000 111',
    saleNumber: 'MAIN-20260301-0042',
    soldAt: new Date('2026-03-01T14:30:00Z'),
    cashierName: 'Ama Mensah',
    lines: [
      { name: 'Rice 5kg', quantity: 2000, unitPrice: 8000, lineTotal: 16000 },
      { name: 'Milo Tin', quantity: 1000, unitPrice: 2500, lineTotal: 2500 },
    ],
    subtotal: 18500,
    discountTotal: 0,
    taxTotal: 0,
    total: 18500,
    payments: [{ method: 'CASH', amount: 20000 }],
    amountPaid: 20000,
    changeGiven: 1500,
  };

  const render = (overrides: Partial<ReceiptData> = {}, width: 32 | 42 = 32) =>
    renderReceipt({ ...base, ...overrides }, width);

  describe('the money', () => {
    it('shows the total the customer paid', () => {
      const total = render().find((l) => l.startsWith('TOTAL'));
      expect(total).toContain('GHS 185.00');
    });

    it('shows each line as quantity, unit price and line total', () => {
      // The arithmetic a customer actually checks. Asserted on content and alignment
      // rather than on exact padding, which is what the width test is for.
      const line = render().find((l) => l.includes('2 x'));
      expect(line).toBeDefined();
      expect(line).toContain('2 x GHS 80.00');
      expect(line).toContain('GHS 160.00');
      expect(line!.endsWith('GHS 160.00'), 'the line total is not right-aligned').toBe(true);
    });

    it('shows the change given', () => {
      expect(render().find((l) => l.startsWith('Change'))).toContain('GHS 15.00');
    });

    it('formats pesewas without losing a leading zero', () => {
      // 5 pesewas is 0.05, not 0.5. A receipt that says the latter is off by a factor of ten.
      const line = render({ total: 5, subtotal: 5 }).find((l) => l.startsWith('TOTAL'));
      expect(line).toContain('GHS 0.05');
    });

    it('never truncates a figure, even when the label is long', () => {
      // The number is the entire point of the document, so it wraps rather than being cut.
      const lines = render(
        {
          lines: [
            {
              name: 'X',
              quantity: 1_000_000,
              unitPrice: 99_999_999,
              lineTotal: 99_999_999_000,
            },
          ],
        },
        32,
      );
      expect(lines.join('\n')).toContain('GHS 999999990.00');
    });

    it('keeps every figure inside the paper width', () => {
      // A thermal printer wraps at the roll width; a line longer than that reappears
      // mangled halfway down the receipt.
      for (const width of [32, 42] as const) {
        for (const line of render({}, width).flatMap((l) => l.split('\n'))) {
          expect(line.length, `"${line}" overflows ${width} columns`).toBeLessThanOrEqual(width);
        }
      }
    });
  });

  describe('fractional quantities', () => {
    it('shows a whole quantity without decimals', () => {
      expect(render().some((l) => l.includes('2 x'))).toBe(true);
    });

    it('shows a genuine fraction', () => {
      const lines = render({
        lines: [{ name: 'Fabric', quantity: 1500, unitPrice: 2000, lineTotal: 3000 }],
      });
      expect(lines.some((l) => l.includes('1.5 x'))).toBe(true);
    });
  });

  describe('what it must say', () => {
    it('names the business and branch', () => {
      const text = receiptText(base);
      expect(text).toContain('ADOM STORES');
      expect(text).toContain('Main Branch');
    });

    it('carries the receipt number, so a sale can be found again', () => {
      expect(receiptText(base)).toContain('MAIN-20260301-0042');
    });

    it('names who served the customer', () => {
      expect(receiptText(base)).toContain('Ama Mensah');
    });

    it('shows a payment reference when there is one', () => {
      const text = receiptText({
        ...base,
        payments: [{ method: 'MOMO', amount: 18500, reference: 'MM-4471' }],
      });
      expect(text).toContain('MM-4471');
    });

    it('lists every tender in a split payment', () => {
      const text = receiptText({
        ...base,
        payments: [
          { method: 'CASH', amount: 10000 },
          { method: 'MOMO', amount: 8500 },
        ],
        changeGiven: 0,
      });
      expect(text).toContain('CASH');
      expect(text).toContain('MOMO');
      expect(text).toContain('GHS 100.00');
      expect(text).toContain('GHS 85.00');
    });

    it('marks a sale the server has not seen yet', () => {
      // Without this, a shop reconciling its day cannot tell an offline sale from a
      // settled one.
      expect(receiptText({ ...base, pendingSync: true })).toContain('NOT YET SYNCED');
    });

    it('says nothing about syncing once the sale has landed', () => {
      expect(receiptText(base)).not.toContain('NOT YET SYNCED');
    });

    it('omits tax and discount lines when there are none', () => {
      // A receipt full of zero rows is harder to read, and a zero tax line invites the
      // question of why tax was charged.
      const text = receiptText(base);
      expect(text).not.toContain('Tax');
      expect(text).not.toContain('Discount');
    });

    it('shows tax and discount when there are some', () => {
      const text = receiptText({ ...base, taxTotal: 1500, discountTotal: 500 });
      expect(text).toContain('Tax');
      expect(text).toContain('-GHS 5.00');
    });
  });

  it('wraps a long product name instead of cutting it', () => {
    const lines = render({
      lines: [
        {
          name: 'Imported Long Grain Parboiled Basmati Rice 25kg',
          quantity: 1000,
          unitPrice: 45000,
          lineTotal: 45000,
        },
      ],
    });
    const text = lines.join('\n');
    expect(text).toContain('Imported Long Grain');
    expect(text).toContain('25kg');
  });
});
