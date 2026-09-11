/**
 * Search text from the URL, made safe to place inside a PostgREST filter.
 *
 * `.or('name.ilike.%term%,sku.ilike.%term%')` is a small filter language, not a bound
 * parameter: a comma starts another condition and parentheses open a group. The products
 * page used to paste the search box's text straight in, so typing `x%,is_active.eq.false`
 * added a condition of the searcher's choosing, and a stray comma or bracket in an ordinary
 * search broke the query. RLS still decided which rows could come back; the shape of the
 * query was simply not the searcher's to decide.
 *
 * The characters that could end a value or a condition are removed. Everything else a
 * person searches for (letters, digits, dashes, dots, spaces) survives.
 */
const RESERVED = /[,()"\\]/g;
const MAX_LENGTH = 60;

export function searchTerm(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(RESERVED, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LENGTH)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** A case-insensitive "contains" across several columns, for `.or()`. */
export function ilikeAny(columns: readonly string[], term: string): string {
  return columns.map((column) => `${column}.ilike.%${term}%`).join(',');
}
