import Link from 'next/link';
import { buttonClasses } from '@carl/ui';

/**
 * Page navigation.
 *
 * Server-rendered links rather than client state, so a page of results can be shared,
 * bookmarked and reached with the browser's back button — all of which a shop manager
 * doing month-end reconciliation actually uses.
 */
export function Pagination({
  page,
  pageCount,
  total,
  basePath,
  searchParams = {},
}: {
  page: number;
  pageCount: number;
  total: number;
  basePath: string;
  searchParams?: Record<string, string | undefined>;
}) {
  if (pageCount <= 1) {
    return (
      <p className="px-4 py-3 text-xs text-[color:var(--color-ink-muted)]">
        {total.toLocaleString('en-GH')} {total === 1 ? 'record' : 'records'}
      </p>
    );
  }

  const href = (target: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined && key !== 'page') params.set(key, value);
    }
    params.set('page', String(target));
    return `${basePath}?${params.toString()}`;
  };

  return (
    <nav
      aria-label="Pagination"
      className="flex items-center justify-between gap-3 border-t border-[color:var(--color-border)] px-4 py-3"
    >
      <p className="text-xs text-[color:var(--color-ink-muted)]">
        Page {page} of {pageCount} · {total.toLocaleString('en-GH')} records
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link
            href={href(page - 1)}
            className={buttonClasses({ variant: 'secondary', size: 'sm' })}
          >
            Previous
          </Link>
        ) : (
          <span
            aria-disabled
            className={buttonClasses({ variant: 'secondary', size: 'sm', className: 'opacity-40' })}
          >
            Previous
          </span>
        )}
        {page < pageCount ? (
          <Link
            href={href(page + 1)}
            className={buttonClasses({ variant: 'secondary', size: 'sm' })}
          >
            Next
          </Link>
        ) : (
          <span
            aria-disabled
            className={buttonClasses({ variant: 'secondary', size: 'sm', className: 'opacity-40' })}
          >
            Next
          </span>
        )}
      </div>
    </nav>
  );
}
