/**
 * Pagination.
 *
 * Carl's tables grow without bound — a busy shop writes thousands of sales a month and an
 * audit log never shrinks. Any query that could return "all of them" is a future outage, so
 * list access goes through these types.
 *
 * Offset pagination is offered for small, bounded, human-browsed lists (branches, staff).
 * Cursor pagination is used everywhere that grows: sales, movements, audit logs. Offset
 * pagination degrades on large tables (the database still walks the skipped rows) and skips
 * or repeats records when data is inserted mid-scan, which for a financial ledger is not an
 * acceptable failure mode.
 */

import { base64UrlToUtf8, utf8ToBase64Url } from './encoding.js';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

export interface OffsetPageRequest {
  readonly page: number; // 1-based
  readonly pageSize: number;
}

export interface CursorPageRequest {
  /** Opaque cursor from a previous response. Absent means "from the beginning". */
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface OffsetPage<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  /** Pass back as `cursor` to fetch the next page. Null when the end has been reached. */
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** Clamps caller-supplied paging into a range the database can serve predictably. */
export function normalizeOffsetPage(request: Partial<OffsetPageRequest>): OffsetPageRequest {
  const pageSize = clamp(request.pageSize ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const page = Math.max(1, Math.trunc(request.page ?? 1));
  return { page, pageSize };
}

export function normalizeCursorPage(request: Partial<CursorPageRequest>): CursorPageRequest {
  const limit = clamp(request.limit ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  return request.cursor === undefined ? { limit } : { limit, cursor: request.cursor };
}

/** Converts a normalized page request into the `[from, to]` range Supabase's `.range()` wants. */
export function toRange(request: OffsetPageRequest): { from: number; to: number } {
  const from = (request.page - 1) * request.pageSize;
  return { from, to: from + request.pageSize - 1 };
}

export function buildOffsetPage<T>(
  items: readonly T[],
  totalItems: number,
  request: OffsetPageRequest,
): OffsetPage<T> {
  const totalPages = Math.max(1, Math.ceil(totalItems / request.pageSize));
  return {
    items,
    page: request.page,
    pageSize: request.pageSize,
    totalItems,
    totalPages,
    hasNextPage: request.page < totalPages,
    hasPreviousPage: request.page > 1,
  };
}

/**
 * A cursor over a `(createdAt, id)` pair.
 *
 * Timestamps alone are not unique — two sales on a busy terminal can share a millisecond —
 * so a timestamp-only cursor silently drops rows at a page boundary. Including the row's id
 * makes the sort total and the page boundary exact.
 */
export interface KeysetCursor {
  readonly createdAt: string;
  readonly id: string;
}

export function encodeCursor(cursor: KeysetCursor): string {
  return utf8ToBase64Url(JSON.stringify(cursor));
}

export function decodeCursor(encoded: string): KeysetCursor | null {
  try {
    const parsed: unknown = JSON.parse(base64UrlToUtf8(encoded));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'createdAt' in parsed &&
      'id' in parsed &&
      typeof (parsed as KeysetCursor).createdAt === 'string' &&
      typeof (parsed as KeysetCursor).id === 'string'
    ) {
      return { createdAt: (parsed as KeysetCursor).createdAt, id: (parsed as KeysetCursor).id };
    }
    return null;
  } catch {
    // A malformed cursor is a client bug or a tampered URL. Restart from the beginning
    // rather than failing the request outright.
    return null;
  }
}

/**
 * Builds a cursor page from a query that deliberately fetched one row more than `limit`.
 *
 * Asking for `limit + 1` reveals whether another page exists without a second COUNT query.
 */
export function buildCursorPage<T>(
  rows: readonly T[],
  limit: number,
  toCursor: (row: T) => KeysetCursor,
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    hasMore,
    nextCursor: hasMore && last !== undefined ? encodeCursor(toCursor(last)) : null,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
