'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

/**
 * Search that keeps the term in the URL, for any list.
 *
 * A filtered list should survive a refresh and be shareable: a manager sending a colleague
 * "that customer's account" should be able to paste a link.
 *
 * Debounced so a search is not issued on every keystroke, which on a slow connection produces
 * a queue of requests that resolve out of order and show the wrong results. The server makes
 * the text safe before it reaches a query (lib/search.ts); nothing here needs to.
 */
export function ListSearch({
  initialQuery,
  placeholder,
  label,
}: {
  initialQuery: string;
  placeholder: string;
  label: string;
}) {
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
      enterKeyHint="search"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      placeholder={placeholder}
      aria-label={label}
      className="pointer-coarse:h-11 h-10 w-full max-w-md rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 text-sm"
    />
  );
}
