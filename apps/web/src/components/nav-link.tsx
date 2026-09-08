'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@carl/ui';

/**
 * A navigation link that knows whether it is the current page.
 *
 * `aria-current="page"` matters as much as the highlight: without it a screen-reader user
 * has no way to tell where they are in the navigation.
 */
export function NavLink({
  href,
  children,
  variant = 'sidebar',
}: {
  href: string;
  children: ReactNode;
  variant?: 'sidebar' | 'bottom';
}) {
  const pathname = usePathname();
  // Exact match for the dashboard, prefix match elsewhere, so /sales/123 keeps Sales lit.
  const active = href === '/' ? pathname === '/' : pathname.startsWith(href);

  if (variant === 'bottom') {
    return (
      <Link
        href={href}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex flex-1 items-center justify-center px-2 py-3 text-xs font-medium',
          active
            ? 'text-[color:var(--color-brand)]'
            : 'text-[color:var(--color-ink-muted)] active:bg-[color:var(--color-surface-muted)]',
        )}
      >
        {children}
      </Link>
    );
  }

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'block rounded-md px-2 py-1.5 text-sm transition-colors',
        active
          ? 'bg-[color:var(--color-brand-soft)] font-medium text-[color:var(--color-brand-strong)]'
          : 'text-[color:var(--color-ink-muted)] hover:bg-[color:var(--color-surface-muted)] hover:text-[color:var(--color-ink)]',
      )}
    >
      {children}
    </Link>
  );
}
