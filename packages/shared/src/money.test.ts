import { describe, expect, it } from 'vitest';
import {
  MAX_MINOR,
  addMoney,
  allocate,
  allocateByRatio,
  formatMoney,
  multiplyMoney,
  parseMoney,
  percentOf,
  roundHalfAwayFromZero,
  subtractMoney,
  toMajor,
  toMinor,
  divideRoundingHalfAwayFromZero,
  taxOnTopOfPrice,
  taxWithinPrice,
} from './money';
import { CarlError } from './errors';

describe('money conversion', () => {
  it('converts major units to exact minor units', () => {
    expect(toMinor(12.5)).toBe(1250);
    expect(toMinor(0.01)).toBe(1);
    expect(toMinor(0)).toBe(0);
    expect(toMinor(-4.2)).toBe(-420);
  });

  it('does not accumulate floating-point error across repeated addition', () => {
    // The reason Carl stores integers at all: 0.1 + 0.2 !== 0.3 in IEEE-754.
    const tenPesewas = toMinor(0.1);
    const twentyPesewas = toMinor(0.2);
    expect(addMoney(tenPesewas, twentyPesewas)).toBe(toMinor(0.3));

    // A thousand small amounts must still reconcile to the pesewa.
    let total = 0;
    for (let i = 0; i < 1000; i += 1) total = addMoney(total, toMinor(0.07));
    expect(total).toBe(toMinor(70));
    expect(toMajor(total)).toBe(70);
  });

  it('rounds sub-pesewa input to the nearest pesewa, half away from zero', () => {
    expect(toMinor(12.344)).toBe(1234);
    expect(toMinor(12.345)).toBe(1235);
    expect(toMinor(-12.345)).toBe(-1235);
  });

  it('rounds a negative half away from zero, so a refund mirrors its sale', () => {
    expect(roundHalfAwayFromZero(0.5)).toBe(1);
    expect(roundHalfAwayFromZero(-0.5)).toBe(-1);
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
  });

  it('rejects amounts beyond the safe integer range', () => {
    expect(() => toMinor(MAX_MINOR)).toThrow(CarlError);
  });
});

describe('parseMoney', () => {
  it('accepts what a cashier actually types', () => {
    expect(parseMoney('1,250.50')).toBe(125050);
    expect(parseMoney('GH₵45')).toBe(4500);
    expect(parseMoney('  12.5  ')).toBe(1250);
    expect(parseMoney('.5')).toBe(50);
  });

  it('rejects ambiguous input rather than guessing', () => {
    for (const bad of ['', 'abc', '12.5.5', '--3', '1e5', '-']) {
      expect(() => parseMoney(bad), `expected "${bad}" to be rejected`).toThrow(CarlError);
    }
  });
});

describe('formatMoney', () => {
  it('renders Ghanaian cedis with grouping and two decimals', () => {
    expect(formatMoney(125050)).toBe('GH₵1,250.50');
    expect(formatMoney(0)).toBe('GH₵0.00');
    expect(formatMoney(-4500)).toBe('-GH₵45.00');
    expect(formatMoney(125050, 'GHS', { withSymbol: false })).toBe('1,250.50');
  });
});

describe('line arithmetic', () => {
  it('multiplies a unit price by a fractional quantity', () => {
    expect(multiplyMoney(1000, 1.5)).toBe(1500);
    expect(multiplyMoney(999, 3)).toBe(2997);
    // 0.333 kg at GH₵10.00/kg -> GH₵3.33
    expect(multiplyMoney(1000, 0.333)).toBe(333);
  });

  it('computes percentage discounts to the pesewa', () => {
    expect(percentOf(10000, 10)).toBe(1000);
    expect(percentOf(999, 15)).toBe(150); // 149.85 -> 150
    expect(subtractMoney(999, percentOf(999, 15))).toBe(849);
  });
});

describe('allocate', () => {
  it('splits evenly when the amount divides cleanly', () => {
    expect(allocate(1000, 4)).toEqual([250, 250, 250, 250]);
  });

  it('distributes the remainder so the split still sums to the original', () => {
    // GH₵10.00 three ways is the classic case where naive rounding loses a pesewa.
    const shares = allocate(1000, 3);
    expect(shares).toEqual([334, 333, 333]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('handles negative amounts (refund splits) without losing a unit', () => {
    const shares = allocate(-1000, 3);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(-1000);
  });

  it('never loses or invents a pesewa, across many shapes', () => {
    for (let amount = -500; amount <= 500; amount += 7) {
      for (let parts = 1; parts <= 9; parts += 1) {
        const shares = allocate(amount, parts);
        expect(shares).toHaveLength(parts);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(amount);
      }
    }
  });
});

describe('allocateByRatio', () => {
  it('spreads an order-level discount across lines in proportion', () => {
    const shares = allocateByRatio(1000, [5000, 3000, 2000]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(shares).toEqual([500, 300, 200]);
  });

  it('still reconciles when the ratio does not divide cleanly', () => {
    const shares = allocateByRatio(100, [1, 1, 1]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('falls back to an even split when all weights are zero', () => {
    expect(allocateByRatio(90, [0, 0, 0]).reduce((a, b) => a + b, 0)).toBe(90);
  });
});

/**
 * Exact integer arithmetic.
 *
 * These exist because floating point and PostgreSQL's `numeric` disagreed by one pesewa on
 * a real basket — the till showed 303168 while the customer was charged 303167. A pesewa is
 * nothing; a till contradicting the receipt is the cashier's problem at the counter.
 */
describe('divideRoundingHalfAwayFromZero', () => {
  it('rounds a half up, away from zero', () => {
    expect(divideRoundingHalfAwayFromZero(5, 2)).toBe(3);
    expect(divideRoundingHalfAwayFromZero(7, 2)).toBe(4);
  });

  it('rounds a negative half away from zero too', () => {
    // Symmetry matters: a refund must mirror the sale it reverses, not round toward it.
    expect(divideRoundingHalfAwayFromZero(-5, 2)).toBe(-3);
    expect(divideRoundingHalfAwayFromZero(5, -2)).toBe(-3);
  });

  it('rounds below the half down', () => {
    expect(divideRoundingHalfAwayFromZero(4, 3)).toBe(1);
    expect(divideRoundingHalfAwayFromZero(2, 3)).toBe(1);
  });

  it('divides exactly when it can', () => {
    expect(divideRoundingHalfAwayFromZero(100, 4)).toBe(25);
    expect(divideRoundingHalfAwayFromZero(0, 7)).toBe(0);
  });

  it('refuses inputs it cannot be exact about', () => {
    expect(() => divideRoundingHalfAwayFromZero(1.5, 2)).toThrow();
    expect(() => divideRoundingHalfAwayFromZero(1, 0)).toThrow();
    // Past 2^53 the products stop being exact and the guarantee is gone.
    expect(() => divideRoundingHalfAwayFromZero(Number.MAX_SAFE_INTEGER + 2, 3)).toThrow();
  });
});

describe('tax arithmetic', () => {
  it('extracts tax from a tax-inclusive price', () => {
    // GHS 112.50 including 12.5% contains GHS 12.50 of tax.
    expect(taxWithinPrice(11250, 12.5)).toBe(1250);
    // GHS 115.00 including 15% contains GHS 15.00.
    expect(taxWithinPrice(11500, 15)).toBe(1500);
  });

  it('adds tax on top of a tax-exclusive price', () => {
    expect(taxOnTopOfPrice(10000, 12.5)).toBe(1250);
    expect(taxOnTopOfPrice(10000, 15)).toBe(1500);
  });

  it('returns nothing for an exempt rate', () => {
    expect(taxWithinPrice(11250, 0)).toBe(0);
    expect(taxOnTopOfPrice(10000, 0)).toBe(0);
  });

  it('agrees with the algebraic definition on awkward amounts', () => {
    /*
     * `net − net/(1 + r/100)` and `net × r/(100 + r)` are the same real number. The first
     * is what the database expresses and the second is what can be computed exactly in
     * integers, so they must round identically on values that land near a boundary.
     */
    for (const rate of [12.5, 15, 3, 7.5]) {
      for (const net of [1, 7, 33, 101, 999, 12_345, 303_167, 1_000_003]) {
        const exact = taxWithinPrice(net, rate);
        const viaReals = Math.round(net - net / (1 + rate / 100));
        // Allowed to differ only where a float lands exactly on .5 and rounds the other way.
        expect(Math.abs(exact - viaReals)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('never returns more tax than the amount itself', () => {
    for (const net of [1, 2, 5, 99, 100_000]) {
      expect(taxWithinPrice(net, 15)).toBeLessThanOrEqual(net);
    }
  });
});
