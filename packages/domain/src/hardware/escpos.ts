/**
 * ESC/POS command generation.
 *
 * ESC/POS is the closest thing thermal receipt printers have to a common language. It is
 * not a standard — it is Epson's protocol that everyone else copied, imperfectly — so this
 * emits only the handful of commands that are near-universal, and treats anything
 * fancier as not worth the risk of printing garbage on a customer's receipt.
 *
 * ## Pure on purpose
 *
 * Every function here turns arguments into bytes. Nothing opens a device, so all of it can
 * be tested without a printer, which matters because there is no printer.
 *
 * ## The character set problem
 *
 * A thermal printer is not Unicode. It has a code page — usually CP437 — and anything
 * outside it prints as a wrong glyph or a black box. `GH₵12.50` on a receipt is precisely
 * the sort of thing that comes out as `GHÔ12.50`, and a customer holding an unreadable
 * price is worse than one holding a plain one. So text is transliterated to ASCII before
 * encoding, and the currency is spelled.
 */

/** Bytes as a command stream. Kept as a plain array so callers can concatenate freely. */
export type Command = readonly number[];

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/** Resets the printer: font, alignment, spacing. Sent before every receipt. */
export const initialize = (): Command => [ESC, 0x40];

export type Alignment = 'left' | 'center' | 'right';

export const align = (alignment: Alignment): Command => [
  ESC,
  0x61,
  alignment === 'left' ? 0 : alignment === 'center' ? 1 : 2,
];

/** Double-height and double-width, for the total. Off again with `emphasis(false)`. */
export const emphasis = (on: boolean): Command => [ESC, 0x21, on ? 0x30 : 0x00];

export const feed = (lines = 1): Command => Array.from({ length: lines }, () => LF);

/**
 * Cuts the paper.
 *
 * A partial cut leaves a small tab holding the receipt on, which is what most shops want:
 * the paper does not fall on the floor between the customer taking it and the next sale.
 * Feeds first, because the blade sits above the print head and an uncut receipt loses its
 * last few lines otherwise.
 */
export const cut = (partial = true): Command => [...feed(4), GS, 0x56, partial ? 0x01 : 0x00];

/**
 * Fires the cash drawer.
 *
 * `ESC p m t1 t2`: pin `m`, then on and off durations in 2ms units. Pin 0 is the common
 * one; some drawers are wired to pin 1, which is why it is a parameter rather than a
 * constant.
 *
 * The pulse is deliberately short. A solenoid held energised too long gets hot, and the
 * drawer is somebody's property.
 */
export const openDrawer = (pin: 0 | 1 = 0, onMs = 50, offMs = 200): Command => [
  ESC,
  0x70,
  pin,
  Math.min(255, Math.round(onMs / 2)),
  Math.min(255, Math.round(offMs / 2)),
];

/**
 * Transliterates to something a CP437 printer can render.
 *
 * Only the characters Carl actually emits are handled — currency symbols, the typographic
 * quotes and dashes that slip in from copied product names, and accented Latin letters.
 * Anything still outside ASCII becomes `?`, which is ugly but legible, and legible is the
 * entire job of a receipt.
 */
export function toPrintableAscii(text: string): string {
  const substitutions: Record<string, string> = {
    // The cedi sign almost always follows "GH", so mapping it to the ISO code would print
    // "GHGHS12.50". "GHC" is what Ghanaians write when they cannot type the symbol.
    '₵': 'C',
    '₦': 'NGN',
    '€': 'EUR',
    '£': 'GBP',
    '₹': 'INR',
    '“': '"',
    '”': '"',
    '‘': "'",
    '’': "'",
    '–': '-',
    '—': '-',
    '…': '...',
    '×': 'x',
    '•': '*',
    ' ': ' ',
  };

  return [...text.normalize('NFKD')]
    .map((char) => {
      if (substitutions[char] !== undefined) return substitutions[char];
      // NFKD has already split accents into base letter plus combining mark; dropping the
      // marks turns "Café" into "Cafe" rather than "Caf?".
      if (/\p{Mn}/u.test(char)) return '';
      const code = char.codePointAt(0) ?? 0;
      if (code >= 0x20 && code <= 0x7e) return char;
      if (char === '\n') return char;
      return '?';
    })
    .join('');
}

/** Encodes one line of text, transliterated, with a line feed. */
export const line = (text: string): Command => [
  ...[...toPrintableAscii(text)].map((c) => c.charCodeAt(0)),
  LF,
];

export interface ReceiptCommandOptions {
  /** Whether to cut the paper afterwards. Some printers have no cutter. */
  readonly cutPaper?: boolean;
  /** Fires the drawer after printing — a cash sale, not a card one. */
  readonly openDrawerAfter?: boolean;
  readonly drawerPin?: 0 | 1;
}

/**
 * A complete receipt, from rendered lines to bytes.
 *
 * Takes the output of `renderReceipt` rather than a sale: the layout is decided once, in
 * the domain, and shared with the on-screen and emailed copies. A printer that laid out its
 * own receipt would be a second definition of what a customer was charged.
 */
export function receiptCommands(
  lines: readonly string[],
  options: ReceiptCommandOptions = {},
): number[] {
  const bytes: number[] = [...initialize(), ...align('left')];
  for (const text of lines) bytes.push(...line(text));
  if (options.cutPaper !== false) bytes.push(...cut(true));
  if (options.openDrawerAfter) bytes.push(...openDrawer(options.drawerPin ?? 0));
  return bytes;
}

/** The drawer on its own, for a cashier opening it between sales. */
export const drawerCommands = (pin: 0 | 1 = 0): number[] => [...initialize(), ...openDrawer(pin)];
