import { describe, expect, it } from 'vitest';
import {
  type Cart,
  type CartLine,
  DiscountKind,
  EMPTY_CART,
  NO_DISCOUNT,
  TaxMode,
  addToCart,
  cartTotals,
  clearCart,
  insufficientLines,
  lineTotals,
  removeFromCart,
  setLineDiscount,
  toSalePayload,
  updateQuantity,
} from './cart';

function line(overrides: Partial<CartLine> = {}): CartLine {
  return {
    productId: 'p1',
    name: 'Rice 5kg',
    sku: 'RICE-5KG',
    unit: 'bag',
    unitPrice: 6500,
    quantity: 1000,
    discount: NO_DISCOUNT,
    taxMode: TaxMode.EXEMPT,
    taxRate: 0,
    allowFractional: false,
    available: 100_000,
    ...overrides,
  };
}

describe('line totals', () => {
  it('multiplies price by quantity', () => {
    expect(lineTotals(line({ quantity: 3000 })).total).toBe(19500);
  });

  it('handles a fractional quantity', () => {
    // 1.5 kg at GH₵10.00/kg
    const totals = lineTotals(line({ unitPrice: 1000, quantity: 1500, allowFractional: true }));
    expect(totals.total).toBe(1500);
  });

  it('applies a percentage discount, rounding half away from zero', () => {
    // GH₵9.99 less 15% is 149.85 pesewas of discount, which must round to 150 — the same
    // rule complete_sale() applies, or the till quotes a price the customer is not charged.
    const totals = lineTotals(
      line({ unitPrice: 999, discount: { kind: DiscountKind.PERCENTAGE, value: 15 } }),
    );
    expect(totals.discount).toBe(150);
    expect(totals.total).toBe(849);
  });

  it('caps a fixed discount at the line value', () => {
    const totals = lineTotals(
      line({ unitPrice: 1000, discount: { kind: DiscountKind.AMOUNT, value: 5000 } }),
    );
    expect(totals.discount).toBe(1000);
    expect(totals.total).toBe(0);
  });

  it('extracts inclusive tax from the shelf price rather than adding it', () => {
    // GH₵115.00 at 15% inclusive contains GH₵15.00 of tax; the customer still pays 115.
    const totals = lineTotals(line({ unitPrice: 11500, taxMode: TaxMode.INCLUSIVE, taxRate: 15 }));
    expect(totals.tax).toBe(1500);
    expect(totals.total).toBe(11500);
  });

  it('adds exclusive tax to the price', () => {
    const totals = lineTotals(line({ unitPrice: 10000, taxMode: TaxMode.EXCLUSIVE, taxRate: 15 }));
    expect(totals.tax).toBe(1500);
    expect(totals.total).toBe(11500);
  });

  it('charges no tax on an exempt product', () => {
    expect(lineTotals(line({ unitPrice: 10000, taxRate: 15, taxMode: TaxMode.EXEMPT })).tax).toBe(
      0,
    );
  });

  it('applies the discount before tax, as the database does', () => {
    // Taxing the undiscounted amount would overcharge; the order of operations has to
    // match complete_sale() exactly.
    const totals = lineTotals(
      line({
        unitPrice: 10000,
        taxMode: TaxMode.EXCLUSIVE,
        taxRate: 15,
        discount: { kind: DiscountKind.PERCENTAGE, value: 10 },
      }),
    );
    expect(totals.net).toBe(9000);
    expect(totals.tax).toBe(1350);
    expect(totals.total).toBe(10350);
  });
});

describe('cart totals', () => {
  it('sums lines and applies an order discount', () => {
    const cart: Cart = {
      ...EMPTY_CART,
      lines: [
        line({ productId: 'a', unitPrice: 10000, quantity: 2000 }),
        line({ productId: 'b', unitPrice: 2500, quantity: 3000 }),
      ],
      orderDiscount: { kind: DiscountKind.PERCENTAGE, value: 10 },
    };

    const totals = cartTotals(cart);
    expect(totals.subtotal).toBe(20000 + 7500);
    expect(totals.orderDiscount).toBe(2750);
    expect(totals.total).toBe(24750);
    expect(totals.itemCount).toBe(2);
    expect(totals.unitCount).toBe(5000);
  });

  it('reports zeroes for an empty cart rather than failing', () => {
    expect(cartTotals(EMPTY_CART)).toMatchObject({ subtotal: 0, total: 0, itemCount: 0 });
  });

  it('never drifts across many small lines', () => {
    // The reason money is integer minor units. A hundred lines of GH₵0.07 must be exactly
    // GH₵7.00, not 6.999999999999.
    const cart: Cart = {
      ...EMPTY_CART,
      lines: Array.from({ length: 100 }, (_, i) => line({ productId: `p${i}`, unitPrice: 7 })),
    };
    expect(cartTotals(cart).total).toBe(700);
  });
});

describe('cart operations', () => {
  it('merges a repeated scan into one line', () => {
    // Scanning the same item five times should read "5 × Rice", not five lines the
    // cashier has to look past to check the basket.
    let cart = addToCart(EMPTY_CART, line());
    cart = addToCart(cart, line());
    cart = addToCart(cart, line());

    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]!.quantity).toBe(3000);
  });

  it('keeps different products on separate lines', () => {
    let cart = addToCart(EMPTY_CART, line({ productId: 'a' }));
    cart = addToCart(cart, line({ productId: 'b' }));
    expect(cart.lines).toHaveLength(2);
  });

  it('removes a line when its quantity reaches zero', () => {
    const cart = updateQuantity(addToCart(EMPTY_CART, line()), 'p1', 0);
    expect(cart.lines).toHaveLength(0);
  });

  it('rounds a fractional quantity for a product sold in whole units', () => {
    // Guards a stray keypress on the quantity field from producing 2.5 bottles.
    const cart = updateQuantity(addToCart(EMPTY_CART, line()), 'p1', 2500);
    expect(cart.lines[0]!.quantity).toBe(3000);
  });

  it('keeps a fraction for a product sold by weight', () => {
    const cart = updateQuantity(addToCart(EMPTY_CART, line({ allowFractional: true })), 'p1', 2500);
    expect(cart.lines[0]!.quantity).toBe(2500);
  });

  it('never mutates the cart it was given', () => {
    // A mutated cart is the classic "the screen did not update" bug, and on a POS it
    // surfaces as a total that does not match the basket.
    const original = addToCart(EMPTY_CART, line());
    const snapshot = JSON.stringify(original);

    addToCart(original, line({ productId: 'b' }));
    updateQuantity(original, 'p1', 9000);
    removeFromCart(original, 'p1');
    setLineDiscount(original, 'p1', { kind: DiscountKind.PERCENTAGE, value: 50 });

    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('keeps the price tier when cleared', () => {
    // A wholesale customer's next basket should not silently revert to retail.
    const cart = clearCart({ ...addToCart(EMPTY_CART, line()), tier: 'WHOLESALE' });
    expect(cart.lines).toHaveLength(0);
    expect(cart.tier).toBe('WHOLESALE');
  });
});

describe('stock warnings', () => {
  it('flags lines the branch cannot cover', () => {
    const cart: Cart = {
      ...EMPTY_CART,
      lines: [
        line({ productId: 'ok', quantity: 2000, available: 5000 }),
        line({ productId: 'short', quantity: 9000, available: 2000 }),
      ],
    };
    expect(insufficientLines(cart).map((l) => l.productId)).toEqual(['short']);
  });

  it('does not flag a product with no stock tracking', () => {
    const cart: Cart = {
      ...EMPTY_CART,
      lines: [line({ quantity: 99_000, available: null })],
    };
    expect(insufficientLines(cart)).toHaveLength(0);
  });
});

describe('sale payload', () => {
  it('carries products and quantities but no prices or totals', () => {
    // The single most important property of this function. A price in the payload would
    // be ignored by the server, but sending one at all invites someone to trust it.
    const cart: Cart = {
      ...EMPTY_CART,
      lines: [
        line({ productId: 'a', unitPrice: 99999, quantity: 2000 }),
        line({
          productId: 'b',
          discount: { kind: DiscountKind.PERCENTAGE, value: 10 },
        }),
      ],
    };

    const payload = toSalePayload(cart);
    expect(payload.items).toEqual([
      { product_id: 'a', quantity: 2 },
      { product_id: 'b', quantity: 1, discount_type: 'PERCENTAGE', discount_value: 10 },
    ]);

    const serialised = JSON.stringify(payload);
    for (const forbidden of ['unitPrice', 'unit_price', 'price', 'total', 'line_total']) {
      expect(serialised, `the payload leaked ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('sends a fractional quantity in decimal units', () => {
    const cart: Cart = {
      ...EMPTY_CART,
      lines: [line({ quantity: 1500, allowFractional: true })],
    };
    expect(toSalePayload(cart).items[0]!.quantity).toBe(1.5);
  });
});
