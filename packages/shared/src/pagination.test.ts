import { describe, expect, it } from 'vitest';
import {
  MAX_PAGE_SIZE,
  buildCursorPage,
  buildOffsetPage,
  decodeCursor,
  encodeCursor,
  normalizeOffsetPage,
  toRange,
} from './pagination';

describe('offset pagination', () => {
  it('clamps hostile or absent page input into a servable range', () => {
    expect(normalizeOffsetPage({ page: 0, pageSize: 0 })).toEqual({ page: 1, pageSize: 1 });
    expect(normalizeOffsetPage({ page: 2, pageSize: 10_000 })).toEqual({
      page: 2,
      pageSize: MAX_PAGE_SIZE,
    });
    expect(normalizeOffsetPage({})).toEqual({ page: 1, pageSize: 25 });
    expect(normalizeOffsetPage({ page: -5, pageSize: Number.NaN })).toEqual({
      page: 1,
      pageSize: 1,
    });
  });

  it('produces an inclusive range for Supabase .range()', () => {
    expect(toRange({ page: 1, pageSize: 25 })).toEqual({ from: 0, to: 24 });
    expect(toRange({ page: 3, pageSize: 10 })).toEqual({ from: 20, to: 29 });
  });

  it('reports page boundaries', () => {
    const page = buildOffsetPage([1, 2, 3], 7, { page: 1, pageSize: 3 });
    expect(page).toMatchObject({ totalPages: 3, hasNextPage: true, hasPreviousPage: false });
  });
});

describe('cursor pagination', () => {
  it('round-trips a keyset cursor', () => {
    const cursor = { createdAt: '2026-01-05T10:00:00.000Z', id: 'abc' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('treats a tampered cursor as "start from the beginning" rather than failing', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor(encodeCursor({ createdAt: 'x', id: 'y' }).slice(0, 4))).toBeNull();
  });

  it('detects a further page from the extra row without a COUNT query', () => {
    const rows = [
      { id: 'a', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', createdAt: '2026-01-02T00:00:00.000Z' },
      { id: 'c', createdAt: '2026-01-03T00:00:00.000Z' },
    ];
    const page = buildCursorPage(rows, 2, (r) => ({ createdAt: r.createdAt, id: r.id }));
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(decodeCursor(page.nextCursor!)).toEqual({
      createdAt: '2026-01-02T00:00:00.000Z',
      id: 'b',
    });
  });

  it('marks the final page', () => {
    const page = buildCursorPage([{ id: 'a', createdAt: 'x' }], 2, (r) => ({
      createdAt: r.createdAt,
      id: r.id,
    }));
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});
