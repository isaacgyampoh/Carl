import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { whatsappNumber } from '../../apps/web/src/lib/receipt-sharing';

/**
 * Sending a customer their receipt.
 *
 * A shop with no printer had nothing to hand a customer at all. Carl sends nothing itself: the
 * shop's own WhatsApp or messaging app does, so there is no gateway to pay for and no message
 * that can leave without the cashier seeing it.
 */
describe('a customer phone number', () => {
  it.each([
    ['024 123 4567', '233241234567'],
    ['0241234567', '233241234567'],
    ['+233 24 123 4567', '233241234567'],
    ['233241234567', '233241234567'],
    ['+44 7700 900123', '447700900123'],
  ])('%s is read as %s', (typed, expected) => {
    expect(whatsappNumber(typed)).toBe(expected);
  });

  it.each<string | null | undefined>([
    null,
    undefined,
    '',
    '   ',
    'not a number',
    '123',
    '+',
    '+12',
  ])('refuses %s rather than guessing', (value) => {
    expect(whatsappNumber(value)).toBeNull();
  });

  it('takes the country code from the business, not from Ghana by assumption', () => {
    expect(whatsappNumber('024 123 4567', '44')).toBe('44241234567');
  });
});

describe('the send button', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', '..', 'apps', 'web', 'src', 'components', 'receipt.tsx'),
    'utf8',
  );

  it("uses the phone's own share sheet first, and offers WhatsApp or a text when there is none", () => {
    expect(source).toContain("typeof navigator.share === 'function'");
    expect(source).toContain('https://wa.me/');
    expect(source).toContain('sms:');
  });

  it('sends the same receipt the printer prints', () => {
    // One layout, so the paper copy and the phone copy cannot disagree.
    expect(source).toContain('renderReceipt(data, 32)');
  });

  it('never posts the receipt anywhere itself', () => {
    // No gateway, no stored number, no message Carl can send on its own.
    expect(source).not.toMatch(/fetch\(|supabase|process\.env/);
  });

  it('is offered at the till and on a past sale', () => {
    const web = (...p: string[]) =>
      readFileSync(join(import.meta.dirname, '..', '..', 'apps', 'web', 'src', ...p), 'utf8');
    expect(web('app', '(app)', 'pos', 'receipt-dialog.tsx')).toContain('<ShareReceiptButton');
    expect(web('app', '(app)', 'sales', '[saleId]', 'page.tsx')).toContain('<ShareReceiptButton');
  });
});
