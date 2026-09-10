/**
 * The cart.
 *
 * ## What this is, and is not
 *
 * A cart is a *proposal*. It holds what the cashier has scanned and what the till is
 * showing, and it computes a total for display. It is not the sale, and its totals are
 * not authoritative — `complete_sale()` re-derives every price and every total from the
 * catalogue when the sale is submitted.
 *
 * That redundancy is deliberate, and the reason for it is worth stating: the cashier must
 * see a running total *instantly* as each item is scanned, and a server round trip per
 * scan would make the till feel broken. So the arithmetic is duplicated — once here for
 * the display, once in PostgreSQL for the truth.
 *
 * Duplicated arithmetic has to agree. Both round half away from zero, both work in integer
 * minor units, and both apply the discount before tax. A test asserts the same basket
 * produces the same total in both places; if they ever diverge, the cashier is quoting a
 * price the customer will not be charged.
 *
 * This module is pure. No React, no network, no clock.
 */

import {
  type Minor,
  type Quantity,
  addMoney,
  assertPositiveQuantity,
  multiplyMoney,
  divideRoundingHalfAwayFromZero,
  taxOnTopOfPrice,
  taxWithinPrice,
  subtractMoney,
} from '@carl/shared';

export const DiscountKind = {
  NONE: 'NONE',
  PERCENTAGE: 'PERCENTAGE',
  AMOUNT: 'AMOUNT',
} as const;

export type DiscountKind = (typeof DiscountKind)[keyof typeof DiscountKind];

export interface Discount {
  readonly kind: DiscountKind;
  /** A percentage (0–100) when kind is PERCENTAGE; minor units when AMOUNT. */
  readonly value: number;
}

export const NO_DISCOUNT: Discount = { kind: DiscountKind.NONE, value: 0 };

export const TaxMode = {
  INCLUSIVE: 'INCLUSIVE',
  EXCLUSIVE: 'EXCLUSIVE',
  EXEMPT: 'EXEMPT',
} as const;

export type TaxMode = (typeof TaxMode)[keyof typeof TaxMode];

export interface CartLine {
  readonly productId: string;
  readonly name: string;
  readonly sku: string;
  readonly unit: string;
  /** Resolved by the server. Never entered by the cashier. */
  readonly unitPrice: Minor;
  readonly quantity: Quantity;
  readonly discount: Discount;
  readonly taxMode: TaxMode;
  /** Percentage, e.g. 15 for 15%. */
  readonly taxRate: number;
  readonly allowFractional: boolean;
  /** Stock on hand at the branch, for warning the cashier before the server refuses. */
  readonly available: Quantity | null;
}

export interface Cart {
  readonly lines: readonly CartLine[];
  readonly orderDiscount: Discount;
  readonly customerId: string | null;
  readonly tier: 'RETAIL' | 'WHOLESALE';
}

export const EMPTY_CART: Cart = {
  lines: [],
  orderDiscount: NO_DISCOUNT,
  customerId: null,
  tier: 'RETAIL',
};

export interface LineTotals {
  readonly gross: Minor;
  readonly discount: Minor;
  readonly net: Minor;
  readonly tax: Minor;
  readonly total: Minor;
}

export interface CartTotals {
  readonly subtotal: Minor;
  readonly orderDiscount: Minor;
  readonly tax: Minor;
  readonly total: Minor;
  readonly itemCount: number;
  readonly unitCount: Quantity;
}

/**
 * Totals for one line.
 *
 * Mirrors `complete_sale()` exactly: quantity × price, less the discount, then tax —
 * extracted from the price for an INCLUSIVE product, added for an EXCLUSIVE one.
 */
export function lineTotals(line: CartLine): LineTotals {
  assertPositiveQuantity(line.quantity, 'line quantity');

  const gross = multiplyMoney(line.unitPrice, line.quantity / 1000);
  /*
   * The discount comes off the UNROUNDED line value, not off `gross`.
   *
   * `complete_sale` computes `round(unit_price * quantity * pct/100)` from the exact
   * product; rounding to `gross` first and discounting that gives a different base whenever
   * the quantity is fractional, and the two answers differ by a minor unit. The till then
   * shows one figure while the customer is charged another.
   */
  const discount = lineDiscountAmount(line.unitPrice, line.quantity, line.discount);
  const net = subtractMoney(gross, discount);

  let tax = 0;
  if (line.taxRate > 0 && line.taxMode !== TaxMode.EXEMPT) {
    /*
     * Computed in exact integer arithmetic, not floating point.
     *
     * PostgreSQL does this in `numeric`, which is exact decimal. Doing it in doubles here
     * disagreed by a single minor unit whenever the true value landed on a rounding
     * boundary — a till showing 303168 while the customer was charged 303167. The pesewa
     * does not matter; a till that contradicts the receipt does.
     */
    tax =
      line.taxMode === TaxMode.EXCLUSIVE
        ? taxOnTopOfPrice(net, line.taxRate)
        : // Inclusive: the tax is already inside `net`, so it is extracted rather than added.
          taxWithinPrice(net, line.taxRate);
  }

  const total = line.taxMode === TaxMode.EXCLUSIVE ? addMoney(net, tax) : net;
  return { gross, discount, net, tax, total };
}

export function cartTotals(cart: Cart): CartTotals {
  let subtotal = 0;
  let tax = 0;
  let unitCount = 0;

  for (const line of cart.lines) {
    const totals = lineTotals(line);
    subtotal = addMoney(subtotal, totals.total);
    tax = addMoney(tax, totals.tax);
    unitCount += line.quantity;
  }

  const orderDiscount = discountAmount(subtotal, cart.orderDiscount);

  return {
    subtotal,
    orderDiscount,
    tax,
    total: subtractMoney(subtotal, orderDiscount),
    itemCount: cart.lines.length,
    unitCount,
  };
}

/**
 * A line's discount, taken from the exact `unitPrice × quantity` rather than from the
 * rounded line total.
 *
 * Quantity is in thousandths and the rate carries three decimals, so both are scaled into
 * integers and divided once — exact arithmetic, matching what PostgreSQL's `numeric` does.
 */
function lineDiscountAmount(unitPrice: Minor, quantity: number, discount: Discount): Minor {
  switch (discount.kind) {
    case DiscountKind.NONE:
      return 0;
    case DiscountKind.PERCENTAGE: {
      const scaledRate = Math.round(discount.value * 1000);
      // unitPrice × (quantity/1000) × (scaledRate/1000) / 100
      return divideRoundingHalfAwayFromZero(unitPrice * quantity * scaledRate, 100_000_000);
    }
    case DiscountKind.AMOUNT:
      // Never more than the thing being discounted; a negative line total is meaningless
      // and the server would refuse the sale anyway.
      return Math.min(discount.value, multiplyMoney(unitPrice, quantity / 1000));
  }
}

/** An order-level discount, taken from an already-rounded subtotal. */
function discountAmount(base: Minor, discount: Discount): Minor {
  switch (discount.kind) {
    case DiscountKind.NONE:
      return 0;
    case DiscountKind.PERCENTAGE: {
      const scaledRate = Math.round(discount.value * 1000);
      return divideRoundingHalfAwayFromZero(base * scaledRate, 100_000);
    }
    case DiscountKind.AMOUNT:
      return Math.min(discount.value, base);
  }
}

// --- Cart operations -----------------------------------------------------------------
// All immutable. A cart is rendered by React, and mutating it in place produces the
// classic "the screen did not update" bug at exactly the wrong moment.

/**
 * Adds a product, merging with an existing line for the same product.
 *
 * Merging matters: scanning the same item five times should show "5 × Rice", not five
 * separate lines the cashier has to read past to check the basket.
 */
export function addToCart(
  cart: Cart,
  line: Omit<CartLine, 'quantity' | 'discount'> & {
    quantity?: Quantity;
    discount?: Discount;
  },
): Cart {
  const quantity = line.quantity ?? 1000;
  const existing = cart.lines.findIndex((l) => l.productId === line.productId);

  if (existing >= 0) {
    return updateQuantity(cart, line.productId, (cart.lines[existing]?.quantity ?? 0) + quantity);
  }

  return {
    ...cart,
    lines: [...cart.lines, { ...line, quantity, discount: line.discount ?? NO_DISCOUNT }],
  };
}

/** Sets a line's quantity. A quantity of zero or less removes the line. */
export function updateQuantity(cart: Cart, productId: string, quantity: Quantity): Cart {
  if (quantity <= 0) return removeFromCart(cart, productId);

  return {
    ...cart,
    lines: cart.lines.map((line) =>
      line.productId === productId
        ? {
            ...line,
            // A product sold in whole units cannot be part-quantitied by a stray keypress.
            quantity: line.allowFractional ? quantity : Math.round(quantity / 1000) * 1000,
          }
        : line,
    ),
  };
}

export function removeFromCart(cart: Cart, productId: string): Cart {
  return { ...cart, lines: cart.lines.filter((line) => line.productId !== productId) };
}

export function setLineDiscount(cart: Cart, productId: string, discount: Discount): Cart {
  return {
    ...cart,
    lines: cart.lines.map((line) => (line.productId === productId ? { ...line, discount } : line)),
  };
}

export function clearCart(cart: Cart): Cart {
  return { ...EMPTY_CART, tier: cart.tier };
}

/** Lines the branch does not have enough stock for. Warns before the server refuses. */
export function insufficientLines(cart: Cart): readonly CartLine[] {
  return cart.lines.filter((line) => line.available !== null && line.quantity > line.available);
}

/**
 * One line as `complete_sale` receives it.
 *
 * Note what has no place here: a price, a line total, a tax amount, a cost. The server
 * derives every one of those. Sending them would be ignored, but having a field for one
 * invites something downstream to trust it.
 */
export interface SaleItemPayload {
  readonly product_id: string;
  /** Decimal units, matching the database's numeric(14,3). */
  readonly quantity: number;
  readonly discount_type?: 'PERCENTAGE' | 'AMOUNT';
  readonly discount_value?: number;
}

/** The payload sent to `complete_sale`. Deliberately carries no prices or totals. */
export function toSalePayload(cart: Cart): { items: SaleItemPayload[] } {
  return {
    items: cart.lines.map((line) => ({
      product_id: line.productId,
      // The wire format is decimal units; the database column is numeric(14,3).
      quantity: line.quantity / 1000,
      ...(line.discount.kind !== DiscountKind.NONE
        ? { discount_type: line.discount.kind, discount_value: line.discount.value }
        : {}),
    })),
  };
}
