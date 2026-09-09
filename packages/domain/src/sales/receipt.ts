/**
 * The receipt.
 *
 * ## Why this is in the domain and not in a printer driver
 *
 * A receipt is the customer's copy of a financial record, and in Ghana it is routinely the
 * only copy either party keeps. What it says has to be exactly what was charged — the same
 * figures, from the same source, as the sale that reached PostgreSQL. Formatting it inside
 * a printer driver would give the web and the desktop two chances to disagree about a
 * total, and the disagreement would be discovered by a customer holding a piece of paper.
 *
 * So this renders lines of text and nothing else. It does not know what a printer is, and
 * it performs no arithmetic of its own beyond laying out figures it is handed.
 *
 * ## Width
 *
 * 32 characters is the usable width of an 80mm thermal roll at the standard font, and 42
 * at the condensed one. Both are supported because both are common; nothing else is.
 */

import type { Minor } from '@carl/shared';

export type ReceiptWidth = 32 | 42;

export interface ReceiptLine {
  readonly name: string;
  /** Thousandths, matching the database's numeric(14,3). */
  readonly quantity: number;
  readonly unitPrice: Minor;
  readonly lineTotal: Minor;
  readonly discount?: Minor;
}

export interface ReceiptPayment {
  readonly method: string;
  readonly amount: Minor;
  readonly reference?: string | null;
}

export interface ReceiptData {
  readonly businessName: string;
  readonly branchName: string;
  readonly addressLines?: readonly string[];
  readonly phone?: string | null;
  /** The tax identifier a shop is required to print, where it has one. */
  readonly taxId?: string | null;

  readonly saleNumber: string;
  readonly soldAt: Date;
  readonly cashierName: string;
  readonly customerName?: string | null;

  readonly lines: readonly ReceiptLine[];
  readonly subtotal: Minor;
  readonly discountTotal: Minor;
  readonly taxTotal: Minor;
  readonly total: Minor;

  readonly payments: readonly ReceiptPayment[];
  readonly amountPaid: Minor;
  readonly changeGiven: Minor;

  readonly currencyCode?: string;
  /**
   * Printed when the sale has not yet reached the server.
   *
   * A shop reconciling its day needs to know which receipts represent sales the server has
   * not seen. Leaving it off makes an offline sale indistinguishable from a settled one.
   */
  readonly pendingSync?: boolean;
  readonly footer?: string | null;
}

const money = (minor: Minor, currency: string): string => {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${currency}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

/** Quantity without trailing zeros: "2" rather than "2.000", but "1.5" stays "1.5". */
const quantity = (thousandths: number): string => {
  const value = thousandths / 1000;
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
};

/** A label on the left and a figure hard against the right margin. */
function columns(left: string, right: string, width: ReceiptWidth): string {
  const gap = width - left.length - right.length;
  // Wraps rather than truncating: a total pushed off the edge of the paper is worse than
  // an ugly line, because the number is the entire point of the document.
  if (gap < 1) return `${left}\n${right.padStart(width)}`;
  return left + ' '.repeat(gap) + right;
}

const centre = (text: string, width: ReceiptWidth): string =>
  text.length >= width ? text : ' '.repeat(Math.floor((width - text.length) / 2)) + text;

const rule = (width: ReceiptWidth, char = '-'): string => char.repeat(width);

/** Splits a name across lines rather than cutting it off mid-word. */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

/**
 * Renders a receipt as plain lines of text.
 *
 * Plain text on purpose: it is what a thermal printer consumes, what an email or a
 * WhatsApp message can carry, and what a test can assert on precisely. Turning it into
 * ESC/POS is the printer layer's job and is a matter of prepending control codes.
 */
export function renderReceipt(data: ReceiptData, width: ReceiptWidth = 32): string[] {
  const currency = data.currencyCode ?? 'GHS ';
  const out: string[] = [];

  out.push(centre(data.businessName.toUpperCase(), width));
  out.push(centre(data.branchName, width));
  for (const line of data.addressLines ?? []) out.push(centre(line, width));
  if (data.phone) out.push(centre(data.phone, width));
  if (data.taxId) out.push(centre(`TIN: ${data.taxId}`, width));
  out.push(rule(width, '='));

  out.push(columns('Receipt', data.saleNumber, width));
  out.push(
    columns(
      data.soldAt.toLocaleDateString('en-GB'),
      data.soldAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      width,
    ),
  );
  out.push(`Served by: ${data.cashierName}`);
  if (data.customerName) out.push(`Customer: ${data.customerName}`);
  out.push(rule(width));

  for (const line of data.lines) {
    for (const part of wrap(line.name, width)) out.push(part);
    // The arithmetic a customer checks: how many, at what price, equals what.
    out.push(
      columns(
        `  ${quantity(line.quantity)} x ${money(line.unitPrice, currency)}`,
        money(line.lineTotal, currency),
        width,
      ),
    );
    if (line.discount && line.discount > 0) {
      out.push(columns('  Discount', `-${money(line.discount, currency)}`, width));
    }
  }

  out.push(rule(width));
  out.push(columns('Subtotal', money(data.subtotal, currency), width));
  if (data.discountTotal > 0) {
    out.push(columns('Discount', `-${money(data.discountTotal, currency)}`, width));
  }
  if (data.taxTotal > 0) out.push(columns('Tax', money(data.taxTotal, currency), width));
  out.push(columns('TOTAL', money(data.total, currency), width));
  out.push(rule(width));

  for (const payment of data.payments) {
    out.push(columns(payment.method, money(payment.amount, currency), width));
    if (payment.reference) out.push(`  Ref: ${payment.reference}`);
  }
  if (data.changeGiven > 0) {
    out.push(columns('Change', money(data.changeGiven, currency), width));
  }

  if (data.pendingSync) {
    // A shop reconciling its day must be able to tell which receipts the server has not
    // seen yet. Silence here makes an offline sale look settled.
    out.push(rule(width));
    out.push(centre('** NOT YET SYNCED **', width));
  }

  out.push(rule(width, '='));
  out.push(centre(data.footer ?? 'Thank you', width));
  return out;
}

/** The receipt as a single string, ready for a printer or a text field. */
export const receiptText = (data: ReceiptData, width: ReceiptWidth = 32): string =>
  renderReceipt(data, width).join('\n');
