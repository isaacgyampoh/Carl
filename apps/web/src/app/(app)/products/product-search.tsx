'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

/**
 * Search that keeps the term in the URL.
 *
 * A filtered list should survive a refresh and be shareable — a manager sending a
 * colleague "the products that are low" should be able to paste a link.
 *
 * Debounced so a search is not issued on every keystroke, which on a slow connection
 * produces a queue of requests that resolve out of order and show the wrong results.
 */
export function ProductSearch({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(initialQuery);
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (value === initialQuery) return;

    const timer = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (value.trim()) params.set('q', value.trim());
      else params.delete('q');
      // A new search always starts at the first page; keeping the old page number would
      // land on an empty one.
      params.delete('page');
      startTransition(() => router.replace(`${pathname}?${params.toString()}`));
    }, 250);

    return () => clearTimeout(timer);
  }, [value, initialQuery, pathname, router, searchParams]);

  return (
    <input
      type="search"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      placeholder="Search by name or SKU"
      aria-label="Search products"
      className="h-10 w-full max-w-sm rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 text-sm"
    />
  );
}
