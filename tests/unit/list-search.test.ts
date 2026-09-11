import { describe, expect, it } from 'vitest';

import { ilikeAny, searchTerm } from '../../apps/web/src/lib/search';

/**
 * Search text is placed inside a PostgREST filter string, where a comma starts another
 * condition and parentheses open a group. Found on the products page: the text went in raw.
 */
describe('search text placed in a filter', () => {
  it('keeps what people actually search for', () => {
    expect(searchTerm('  Milo 400g ')).toBe('Milo 400g');
    expect(searchTerm('FRY-1.5L')).toBe('FRY-1.5L');
    expect(searchTerm('S-00412')).toBe('S-00412');
    expect(searchTerm('024 555 0101')).toBe('024 555 0101');
  });

  it('cannot add a condition or open a group', () => {
    const term = searchTerm('x%,is_active.eq.false),or(tenant_id.neq.0');
    expect(term).not.toMatch(/[,()]/);
    // One condition per column, however the text was crafted.
    expect(ilikeAny(['name', 'sku'], term!).split(',')).toHaveLength(2);
  });

  it('cannot close a quoted value or escape', () => {
    expect(searchTerm('a"b\\c')).toBe('a b c');
  });

  it('treats blank and missing as no search, and bounds the length', () => {
    expect(searchTerm(undefined)).toBeNull();
    expect(searchTerm('   ')).toBeNull();
    expect(searchTerm(',,,')).toBeNull();
    expect(searchTerm('a'.repeat(500))).toHaveLength(60);
  });

  it('builds a contains filter for each column', () => {
    expect(ilikeAny(['name', 'phone'], 'ama')).toBe('name.ilike.%ama%,phone.ilike.%ama%');
  });
});
