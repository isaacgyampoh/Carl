import 'server-only';

import { cache } from 'react';
import type { CarlSupabaseClient } from '@/lib/supabase';

/**
 * Shared read helpers for list screens.
 *
 * Every one of these paginates. Carl's tables grow without bound — a busy shop writes
 * thousands of sales a month and an audit log never shrinks — so a query that could return
 * "all of them" is a future outage rather than a convenience.
 *
 * None of them filters by tenant. That is not an oversight: Row Level Security already
 * confines every row to the caller, and adding a redundant `.eq('tenant_id', …)` would
 * imply the filter is what provides the isolation. It is not, and a reader who believes it
 * is will eventually write a query that forgets it.
 */

export const PAGE_SIZE = 25;

export interface Page<T> {
  readonly rows: T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
}

/** Clamps caller-supplied paging into a range the database can serve predictably. */
export function pageParams(searchParams: Record<string, string | undefined>): {
  page: number;
  pageSize: number;
  from: number;
  to: number;
} {
  const page = Math.max(1, Number.parseInt(searchParams.page ?? '1', 10) || 1);
  const pageSize = PAGE_SIZE;
  const from = (page - 1) * pageSize;
  return { page, pageSize, from, to: from + pageSize - 1 };
}

export function toPage<T>(
  rows: T[] | null,
  count: number | null,
  page: number,
  pageSize: number,
): Page<T> {
  const total = count ?? 0;
  return {
    rows: rows ?? [],
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/**
 * Branches the caller may act in.
 *
 * Cached per request: several components on one page need the branch list, and resolving
 * it once avoids the same query running five times for one render.
 */
export const listBranches = cache(
  async (client: CarlSupabaseClient): Promise<{ id: string; code: string; name: string }[]> => {
    const { data } = await client
      .from('branches')
      .select('id, code, name')
      .eq('is_active', true)
      .order('code');
    return data ?? [];
  },
);
