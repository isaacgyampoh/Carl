/**
 * Money in Carl.
 *
 * ## Why integers
 *
 * A POS adds thousands of amounts a day and must reconcile against physical cash in a drawer.
 * IEEE-754 doubles cannot represent 0.10 exactly, so `0.1 + 0.2 !== 0.3`, and a day of
 * floating-point arithmetic produces a till that is off by a few pesewas with no explanation.
 *
 * Every monetary amount in Carl is therefore an **integer count of minor units** — pesewas for
 * GHS, cents for USD. `GH₵12.50` is the integer `1250`. The database stores `bigint`. Nothing
 * anywhere multiplies or divides a floating-point currency amount.
 *
 * ## Rounding
 *
 * Division (percentage discounts, tax, splitting a total) cannot always produce a whole number
 * of pesewas. Carl rounds **half away from zero** — the rule a human cashier would apply, and
 * the one PostgreSQL's `round()` on `numeric` uses, so the database and the application agree
 * to the pesewa. `allocate()` exists for the cases where a rounded split must still sum
 * exactly to the original.
 */

import { CarlError, ErrorCode } from './errors.js';

/** An integer count of a currency's minor units. Never a fractional value. */
export type Minor = number;

/** ISO-4217 currency codes Carl understands. */
export const Currency = {
  GHS: 'GHS',
  USD: 'USD',
  EUR: 'EUR',
  GBP: 'GBP',
  NGN: 'NGN',
} as const;

export type Currency = (typeof Currency)[keyof typeof Currency];

/** Minor units per major unit, per currency. All currently supported currencies use 100. */
const MINOR_UNITS_PER_MAJOR: Record<Currency, number> = {
  GHS: 100,
  USD: 100,
  EUR: 100,
  GBP: 100,
  NGN: 100,
};

const CURRENCY_SYMBOL: Record<Currency, string> = {
  GHS: 'GH₵',
  USD: '$',
  EUR: '€',
  GBP: '£',
  NGN: '₦',
};

/**
 * The largest amount Carl will handle, in minor units.
 *
 * Well inside `Number.MAX_SAFE_INTEGER` so that every intermediate sum stays exact, while
 * still permitting an implausibly large single transaction. Anything beyond this is a bug or
 * an attack, not a sale.
 */
export const MAX_MINOR = 1_000_000_000_000; // 10 billion major units

export function isValidMinor(value: unknown): value is Minor {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= MAX_MINOR;
}

/** Asserts that a value is a usable minor-unit amount, naming the field if it is not. */
export function assertMinor(value: unknown, field = 'amount'): asserts value is Minor {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CarlError(ErrorCode.VALIDATION_FAILED, `${field} must be a finite number.`);
  }
  if (!Number.isInteger(value)) {
    throw new CarlError(
      ErrorCode.VALIDATION_FAILED,
      `${field} must be a whole number of minor units. Received ${value}.`,
    );
  }
  if (Math.abs(value) > MAX_MINOR) {
    throw new CarlError(
      ErrorCode.VALIDATION_FAILED,
      `${field} exceeds the maximum permitted amount.`,
    );
  }
}

/**
 * Rounds half away from zero.
 *
 * `Math.round` rounds half *up* (toward +∞), so `Math.round(-0.5)` is `-0`, which makes a
 * refund round differently from the sale it reverses. This does not.
 */
export function roundHalfAwayFromZero(value: number): number {
  if (!Number.isFinite(value)) {
    throw new CarlError(ErrorCode.VALIDATION_FAILED, 'Cannot round a non-finite amount.');
  }
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Converts a major-unit amount (`12.5`) to minor units (`1250`). */
export function toMinor(major: number, currency: Currency = Currency.GHS): Minor {
  if (!Number.isFinite(major)) {
    throw new CarlError(ErrorCode.VALIDATION_FAILED, 'Amount must be a finite number.');
  }
  const factor = MINOR_UNITS_PER_MAJOR[currency];
  // Scale before rounding so 12.345 -> 1234.5 -> 1235 rather than compounding float error.
  const minor = roundHalfAwayFromZero(major * factor);
  assertMinor(minor);
  return minor;
}

/** Converts minor units (`1250`) to a major-unit number (`12.5`). For display only. */
export function toMajor(minor: Minor, currency: Currency = Currency.GHS): number {
  assertMinor(minor);
  return minor / MINOR_UNITS_PER_MAJOR[currency];
}

/**
 * Parses user-entered text into minor units.
 *
 * Accepts grouped input ("1,250.50") and a leading currency symbol, because cashiers type what
 * they see on a price tag. Rejects anything else rather than guessing.
 */
export function parseMoney(input: string, currency: Currency = Currency.GHS): Minor {
  const cleaned = input
    .trim()
    .replace(CURRENCY_SYMBOL[currency], '')
    .replace(/[\s,_]/g, '');
  if (cleaned === '' || !/^-?\d*(\.\d+)?$/.test(cleaned) || cleaned === '-') {
    throw new CarlError(ErrorCode.VALIDATION_FAILED, `"${input}" is not a valid amount.`);
  }
  return toMinor(Number(cleaned), currency);
}

/** Formats minor units for display, e.g. `GH₵1,250.50`. */
export function formatMoney(
  minor: Minor,
  currency: Currency = Currency.GHS,
  options: { readonly withSymbol?: boolean; readonly locale?: string } = {},
): string {
  assertMinor(minor);
  const { withSymbol = true, locale = 'en-GH' } = options;
  const digits = String(MINOR_UNITS_PER_MAJOR[currency]).length - 1;
  const body = Math.abs(toMajor(minor, currency)).toLocaleString(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const sign = minor < 0 ? '-' : '';
  return withSymbol ? `${sign}${CURRENCY_SYMBOL[currency]}${body}` : `${sign}${body}`;
}

export function currencySymbol(currency: Currency): string {
  return CURRENCY_SYMBOL[currency];
}

// --- Arithmetic --------------------------------------------------------------------------
// These are deliberately thin. Their value is that every call site is auditable and every
// result is re-checked against MAX_MINOR, so an overflow surfaces where it happens.

export function addMoney(...amounts: readonly Minor[]): Minor {
  let total = 0;
  for (const amount of amounts) {
    assertMinor(amount);
    total += amount;
  }
  assertMinor(total, 'total');
  return total;
}

export function subtractMoney(a: Minor, b: Minor): Minor {
  assertMinor(a);
  assertMinor(b);
  const result = a - b;
  assertMinor(result);
  return result;
}

export function negateMoney(amount: Minor): Minor {
  assertMinor(amount);
  return -amount;
}

/**
 * Multiplies an amount by a quantity, rounding to whole minor units.
 *
 * Quantities may be fractional (1.5 kg of rice), so the product generally is not a whole
 * number of pesewas. The rounded result is what the customer is charged for that line.
 */
export function multiplyMoney(amount: Minor, factor: number): Minor {
  assertMinor(amount);
  if (!Number.isFinite(factor)) {
    throw new CarlError(ErrorCode.VALIDATION_FAILED, 'Multiplier must be a finite number.');
  }
  const result = roundHalfAwayFromZero(amount * factor);
  assertMinor(result);
  return result;
}

/** Applies a percentage (`10` means 10%), rounding to whole minor units. */
export function percentOf(amount: Minor, percent: number): Minor {
  if (!Number.isFinite(percent)) {
    throw new CarlError(ErrorCode.VALIDATION_FAILED, 'Percentage must be a finite number.');
  }
  return multiplyMoney(amount, percent / 100);
}

/**
 * Splits an amount into `parts` shares that sum **exactly** back to the original.
 *
 * Rounding each share independently loses or invents pesewas: GH₵10.00 split three ways
 * becomes 3.33 × 3 = GH₵9.99. This distributes the remainder one minor unit at a time across
 * the leading shares, so the split always reconciles.
 */
export function allocate(amount: Minor, parts: number): Minor[] {
  assertMinor(amount);
  if (!Number.isInteger(parts) || parts < 1) {
    throw new CarlError(ErrorCode.VALIDATION_FAILED, 'Split count must be a positive integer.');
  }
  const base = Math.trunc(amount / parts);
  const shares = new Array<number>(parts).fill(base);
  let remainder = amount - base * parts;
  const step = remainder < 0 ? -1 : 1;
  for (let i = 0; remainder !== 0; i = (i + 1) % parts) {
    shares[i] = (shares[i] ?? 0) + step;
    remainder -= step;
  }
  return shares;
}

/**
 * Splits an amount across weighted shares that sum exactly to the original.
 *
 * Used to spread an order-level discount over its lines so each line's recorded revenue stays
 * consistent with the order total.
 */
export function allocateByRatio(amount: Minor, weights: readonly number[]): Minor[] {
  assertMinor(amount);
  if (weights.length === 0) {
    throw new CarlError(ErrorCode.VALIDATION_FAILED, 'At least one weight is required.');
  }
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new CarlError(ErrorCode.VALIDATION_FAILED, 'Weights must be finite and non-negative.');
  }
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) return allocate(amount, weights.length);

  const shares = weights.map((w) => Math.trunc((amount * w) / totalWeight));
  let remainder = amount - shares.reduce((sum, s) => sum + s, 0);
  const step = remainder < 0 ? -1 : 1;
  for (let i = 0; remainder !== 0; i = (i + 1) % shares.length) {
    shares[i] = (shares[i] ?? 0) + step;
    remainder -= step;
  }
  return shares;
}

export function compareMoney(a: Minor, b: Minor): -1 | 0 | 1 {
  assertMinor(a);
  assertMinor(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

export const isZero = (amount: Minor): boolean => amount === 0;
export const isPositive = (amount: Minor): boolean => amount > 0;
export const isNegative = (amount: Minor): boolean => amount < 0;
