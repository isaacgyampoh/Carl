import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Cart,
  type TaxMode,
  DiscountKind,
  EMPTY_CART,
  NO_DISCOUNT,
  cartTotals,
  toSalePayload,
} from '@carl/domain';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { createShop, sell, type Shop } from '../support/pos.js';

/**
 * The cart's arithmetic must agree with the database's, exactly.
 *
 * Carl computes a total twice: once in the browser so the cashier sees a running figure
 * the instant an item is scanned, and once in PostgreSQL because that is the only number
 * the customer is actually charged.
 *
 * Duplicated arithmetic drifts. When it does, the till quotes a price and the receipt
 * shows another — which a customer notices immediately and a shop cannot explain. This
 * suite runs real baskets through both and asserts they land on the same pesewa.
 *
 * The cases are chosen to be exactly where naive implementations diverge: percentages
 * that do not divide evenly, inclusive tax, discount-then-tax ordering, and fractional
 * quantities.
 */
/** Chooses the tax mode a generated product should carry. */
function taxModeFor(product: { taxRate: number; inclusive: boolean }): TaxMode {
  if (product.taxRate === 0) return 'EXEMPT';
  return product.inclusive ? 'INCLUSIVE' : 'EXCLUSIVE';
}

describe('the cart agrees with the database', () => {
  let db: TestDatabase;
  let shop: Shop;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.reset();
    shop = await createShop(db);
  });

  interface Scenario {
    readonly name: string;
    readonly products: {
      price: number;
      cost?: number;
      taxMode?: 'INCLUSIVE' | 'EXCLUSIVE' | 'EXEMPT';
      taxRate?: number;
      allowFractional?: boolean;
    }[];
    /** Quantity in thousandths, matching the cart's internal representation. */
    readonly lines: {
      quantity: number;
      discount?: { kind: 'PERCENTAGE' | 'AMOUNT'; value: number };
    }[];
    readonly orderDiscount?: { kind: 'PERCENTAGE' | 'AMOUNT'; value: number };
  }

  const scenarios: readonly Scenario[] = [
    {
      name: 'a plain basket',
      products: [{ price: 6500 }, { price: 2200 }],
      lines: [{ quantity: 2000 }, { quantity: 3000 }],
    },
    {
      name: 'a percentage discount that does not divide evenly',
      products: [{ price: 999 }],
      lines: [{ quantity: 1000, discount: { kind: 'PERCENTAGE', value: 15 } }],
    },
    {
      name: 'a percentage discount on a multi-unit line',
      products: [{ price: 1333 }],
      lines: [{ quantity: 7000, discount: { kind: 'PERCENTAGE', value: 12.5 } }],
    },
    {
      name: 'a fixed discount',
      products: [{ price: 10000 }],
      lines: [{ quantity: 1000, discount: { kind: 'AMOUNT', value: 1750 } }],
    },
    {
      name: 'inclusive tax',
      products: [{ price: 11500, taxMode: 'INCLUSIVE', taxRate: 15 }],
      lines: [{ quantity: 3000 }],
    },
    {
      name: 'exclusive tax',
      products: [{ price: 10000, taxMode: 'EXCLUSIVE', taxRate: 15 }],
      lines: [{ quantity: 2000 }],
    },
    {
      name: 'discount before tax',
      products: [{ price: 10000, taxMode: 'EXCLUSIVE', taxRate: 15 }],
      lines: [{ quantity: 1000, discount: { kind: 'PERCENTAGE', value: 10 } }],
    },
    {
      name: 'an awkward inclusive rate',
      products: [{ price: 777, taxMode: 'INCLUSIVE', taxRate: 12.5 }],
      lines: [{ quantity: 3000 }],
    },
    {
      name: 'a fractional quantity',
      products: [{ price: 1000, allowFractional: true }],
      lines: [{ quantity: 1500 }],
    },
    {
      name: 'a fraction that does not divide evenly',
      products: [{ price: 1000, allowFractional: true }],
      lines: [{ quantity: 333 }],
    },
    {
      name: 'an order-level discount',
      products: [{ price: 3333 }, { price: 1777 }],
      lines: [{ quantity: 3000 }, { quantity: 2000 }],
      orderDiscount: { kind: 'PERCENTAGE', value: 7.5 },
    },
    {
      name: 'a mixed basket with every complication at once',
      products: [
        { price: 6500 },
        { price: 999, taxMode: 'EXCLUSIVE', taxRate: 15 },
        { price: 1250, taxMode: 'INCLUSIVE', taxRate: 15, allowFractional: true },
      ],
      lines: [
        { quantity: 2000 },
        { quantity: 3000, discount: { kind: 'PERCENTAGE', value: 10 } },
        { quantity: 2500 },
      ],
      orderDiscount: { kind: 'PERCENTAGE', value: 5 },
    },
  ];

  for (const scenario of scenarios) {
    it(`matches for ${scenario.name}`, async () => {
      const productIds: string[] = [];
      for (const product of scenario.products) {
        productIds.push(
          await shop.stock({
            price: product.price,
            quantity: 1000,
            ...(product.cost !== undefined ? { cost: product.cost } : {}),
            ...(product.taxMode !== undefined ? { taxMode: product.taxMode } : {}),
            ...(product.taxRate !== undefined ? { taxRate: product.taxRate } : {}),
            ...(product.allowFractional !== undefined
              ? { allowFractional: product.allowFractional }
              : {}),
          }),
        );
      }

      // Build the cart the till would have built.
      const cart: Cart = {
        ...EMPTY_CART,
        lines: scenario.lines.map((line, index) => {
          const product = scenario.products[index]!;
          return {
            productId: productIds[index]!,
            name: `Product ${index}`,
            sku: `SKU-${index}`,
            unit: 'unit',
            unitPrice: product.price,
            quantity: line.quantity,
            discount: line.discount
              ? { kind: DiscountKind[line.discount.kind], value: line.discount.value }
              : NO_DISCOUNT,
            taxMode: product.taxMode ?? 'EXEMPT',
            taxRate: product.taxRate ?? 0,
            allowFractional: product.allowFractional ?? false,
            available: 1_000_000,
          };
        }),
        orderDiscount: scenario.orderDiscount
          ? { kind: DiscountKind[scenario.orderDiscount.kind], value: scenario.orderDiscount.value }
          : NO_DISCOUNT,
      };

      const displayed = cartTotals(cart).total;

      // Submit exactly what the till would submit — products and quantities only.
      const payload = toSalePayload(cart);
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: payload.items,
        payments: [{ method: 'CASH', amount: displayed }],
        ...(scenario.orderDiscount
          ? {
              orderDiscount: {
                type: scenario.orderDiscount.kind,
                value: scenario.orderDiscount.value,
                reason: 'Test scenario',
              },
            }
          : {}),
      });

      expect(
        sale.total,
        `the till showed ${displayed} but the customer was charged ${sale.total}`,
      ).toBe(displayed);
    });
  }

  it('agrees across a hundred randomly generated baskets', async () => {
    // Property-based rather than example-based: the cases above are the ones a person
    // thinks of, and rounding bugs hide in the ones nobody does.
    const products: { id: string; price: number; taxRate: number; inclusive: boolean }[] = [];
    for (let i = 0; i < 6; i += 1) {
      const price = 100 + Math.floor(Math.random() * 20_000);
      const taxRate = [0, 0, 12.5, 15][i % 4]!;
      const inclusive = i % 2 === 0;
      products.push({
        id: await shop.stock({
          price,
          quantity: 1_000_000,
          taxMode: taxRate === 0 ? 'EXEMPT' : inclusive ? 'INCLUSIVE' : 'EXCLUSIVE',
          ...(taxRate > 0 ? { taxRate } : {}),
        }),
        price,
        taxRate,
        inclusive,
      });
    }

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const lineCount = 1 + Math.floor(Math.random() * 4);
      const chosen = [...products].sort(() => Math.random() - 0.5).slice(0, lineCount);

      const cart: Cart = {
        ...EMPTY_CART,
        lines: chosen.map((product) => ({
          productId: product.id,
          name: 'x',
          sku: 'x',
          unit: 'unit',
          unitPrice: product.price,
          quantity: (1 + Math.floor(Math.random() * 9)) * 1000,
          discount:
            Math.random() < 0.4
              ? { kind: DiscountKind.PERCENTAGE, value: Math.round(Math.random() * 20 * 4) / 4 }
              : NO_DISCOUNT,
          taxMode: taxModeFor(product),
          taxRate: product.taxRate,
          allowFractional: false,
          available: 1_000_000,
        })),
      };

      const displayed = cartTotals(cart).total;
      const sale = await sell(db, shop.ownerUserId, shop.branchId, {
        items: toSalePayload(cart).items,
        payments: [{ method: 'CASH', amount: displayed }],
      });

      expect(
        sale.total,
        `basket ${attempt}: till showed ${displayed}, charged ${sale.total}\n` +
          JSON.stringify(cart.lines, null, 2),
      ).toBe(displayed);
    }
  });
});
