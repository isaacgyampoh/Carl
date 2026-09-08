/**
 * Quantity in Carl.
 *
 * Not every product is sold in whole units. A shop sells 1.5 kg of rice, 0.75 m of fabric, or
 * 2.25 litres of oil, so quantity cannot be an integer count. It also cannot be a float, for
 * exactly the reason money cannot: `0.1 + 0.2 !== 0.3`, and stock levels that drift by a
 * millionth of a unit break equality checks and reconcile incorrectly at stock-take.
 *
 * Quantities are therefore integers counted in **thousandths of a unit**. `1.5 kg` is `1500`.
 * Three decimal places matches `numeric(14,3)` in PostgreSQL and is finer than any scale a
 * retail shop weighs to.
 */

import { CarlError, ErrorCode } from './errors';

/** An integer count of thousandths of a unit. */
export type Quantity = number;

/** Thousandths per whole unit. */
export const QUANTITY_SCALE = 1000;

/** Decimal places a quantity can express. Must match the database's `numeric(_, 3)`. */
export const QUANTITY_DECIMALS = 3;

export const ONE_UNIT: Quantity = QUANTITY_SCALE;
export const ZERO_QUANTITY: Quantity = 0;

/** Generous upper bound; a single line beyond this is a data-entry error, not a sale. */
export const MAX_QUANTITY: Quantity = 1_000_000_000;

export function isValidQuantity(value: unknown): value is Quantity {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= MAX_QUANTITY;
}

export function assertQuantity(value: unknown, field = 'quantity'): asserts value is Quantity {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CarlError(ErrorCode.INVALID_QUANTITY, `${field} must be a finite number.`);
  }
  if (!Number.isInteger(value)) {
    throw new CarlError(
      ErrorCode.INVALID_QUANTITY,
      `${field} must be expressed in whole thousandths of a unit.`,
    );
  }
  if (Math.abs(value) > MAX_QUANTITY) {
    throw new CarlError(
      ErrorCode.INVALID_QUANTITY,
      `${field} exceeds the maximum permitted quantity.`,
    );
  }
}

/** Asserts a quantity is strictly greater than zero — required for a saleable line. */
export function assertPositiveQuantity(
  value: unknown,
  field = 'quantity',
): asserts value is Quantity {
  assertQuantity(value, field);
  if (value <= 0) {
    throw new CarlError(ErrorCode.INVALID_QUANTITY, `${field} must be greater than zero.`);
  }
}

/** Converts a decimal unit count (`1.5`) into internal thousandths (`1500`). */
export function toQuantity(units: number): Quantity {
  if (!Number.isFinite(units)) {
    throw new CarlError(ErrorCode.INVALID_QUANTITY, 'Quantity must be a finite number.');
  }
  const scaled = units * QUANTITY_SCALE;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  assertQuantity(rounded);
  return rounded;
}

/** Converts internal thousandths (`1500`) back to a unit count (`1.5`). For display and maths. */
export function toUnits(quantity: Quantity): number {
  assertQuantity(quantity);
  return quantity / QUANTITY_SCALE;
}

/** Parses cashier-entered text into a quantity. */
export function parseQuantity(input: string): Quantity {
  const cleaned = input.trim().replace(/[\s,_]/g, '');
  if (cleaned === '' || !/^-?\d*(\.\d+)?$/.test(cleaned) || cleaned === '-') {
    throw new CarlError(ErrorCode.INVALID_QUANTITY, `"${input}" is not a valid quantity.`);
  }
  return toQuantity(Number(cleaned));
}

/**
 * Formats a quantity for display, trimming trailing zeros.
 *
 * A pack of 3 shows as "3", not "3.000"; 1.5 kg shows as "1.5". Receipts and stock lists are
 * read at a glance, and noise costs the reader time.
 */
export function formatQuantity(
  quantity: Quantity,
  options: { readonly unit?: string } = {},
): string {
  assertQuantity(quantity);
  const fixed = toUnits(quantity).toFixed(QUANTITY_DECIMALS);
  const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
  return options.unit ? `${trimmed} ${options.unit}` : trimmed;
}

/** Serialises a quantity for a PostgreSQL `numeric(14,3)` column. */
export function toNumericString(quantity: Quantity): string {
  assertQuantity(quantity);
  return toUnits(quantity).toFixed(QUANTITY_DECIMALS);
}

/** Reads a PostgreSQL `numeric` value (delivered as a string or a number) into a quantity. */
export function fromNumeric(value: string | number): Quantity {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CarlError(
      ErrorCode.INVALID_QUANTITY,
      `Cannot read "${String(value)}" as a quantity.`,
    );
  }
  return toQuantity(parsed);
}

export function addQuantity(...quantities: readonly Quantity[]): Quantity {
  let total = 0;
  for (const quantity of quantities) {
    assertQuantity(quantity);
    total += quantity;
  }
  assertQuantity(total, 'total quantity');
  return total;
}

export function subtractQuantity(a: Quantity, b: Quantity): Quantity {
  assertQuantity(a);
  assertQuantity(b);
  const result = a - b;
  assertQuantity(result);
  return result;
}

export function negateQuantity(quantity: Quantity): Quantity {
  assertQuantity(quantity);
  return -quantity;
}

export function compareQuantity(a: Quantity, b: Quantity): -1 | 0 | 1 {
  assertQuantity(a);
  assertQuantity(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether `available` covers `required`. The single place stock sufficiency is decided. */
export function coversQuantity(available: Quantity, required: Quantity): boolean {
  assertQuantity(available);
  assertQuantity(required);
  return available >= required;
}
