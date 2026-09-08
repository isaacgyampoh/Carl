import { describe, expect, it } from 'vitest';
import { CarlError } from './errors.js';
import {
  addQuantity,
  coversQuantity,
  formatQuantity,
  fromNumeric,
  parseQuantity,
  subtractQuantity,
  toNumericString,
  toQuantity,
  toUnits,
} from './quantity.js';

describe('quantity', () => {
  it('represents fractional units exactly', () => {
    expect(toQuantity(1.5)).toBe(1500);
    expect(toQuantity(0.001)).toBe(1);
    expect(toUnits(1500)).toBe(1.5);
  });

  it('adds fractional weights without floating-point drift', () => {
    expect(addQuantity(toQuantity(0.1), toQuantity(0.2))).toBe(toQuantity(0.3));
    let total = 0;
    for (let i = 0; i < 300; i += 1) total = addQuantity(total, toQuantity(0.1));
    expect(toUnits(total)).toBe(30);
  });

  it('formats without trailing zero noise', () => {
    expect(formatQuantity(3000)).toBe('3');
    expect(formatQuantity(1500)).toBe('1.5');
    expect(formatQuantity(1250, { unit: 'kg' })).toBe('1.25 kg');
    expect(formatQuantity(0)).toBe('0');
  });

  it('round-trips through the PostgreSQL numeric representation', () => {
    expect(toNumericString(1500)).toBe('1.500');
    expect(fromNumeric('1.500')).toBe(1500);
    expect(fromNumeric(2.25)).toBe(2250);
  });

  it('rejects malformed cashier input', () => {
    for (const bad of ['', 'two', '1.2.3', '-']) {
      expect(() => parseQuantity(bad), `expected "${bad}" to be rejected`).toThrow(CarlError);
    }
    expect(parseQuantity('2.5')).toBe(2500);
  });

  it('decides stock sufficiency at the boundary correctly', () => {
    expect(coversQuantity(1000, 1000)).toBe(true);
    expect(coversQuantity(999, 1000)).toBe(false);
    expect(coversQuantity(0, 1)).toBe(false);
  });

  it('supports negative movement quantities for outbound ledger entries', () => {
    expect(subtractQuantity(toQuantity(1), toQuantity(3))).toBe(toQuantity(-2));
  });
});
