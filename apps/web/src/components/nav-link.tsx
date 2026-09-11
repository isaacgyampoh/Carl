'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@carl/ui';

/**
 * Whether `href` is the current page or a page beneath it.
 *
 * A segment boundary, not a string prefix: `startsWith` alone lit the owner's Overview
 * (`/platform`) on every console page, since every one of them begins with it. `exact` is for
 * a section's front page, which must not claim its children.
 */
export function isActivePath(pathname: string, href: string, exact = false): boolean {
  if (pathname === href) return true;
  return !exact && pathname.startsWith(`${href}/`);
}

export type NavVariant = 'sidebar' | 'rail' | 'tab' | 'sheet';

/** Shared with the phone's More button, so it matches the tabs beside it exactly. */
export function navClasses(variant: NavVariant, active: boolean): string {
  switch (variant) {
    case 'sidebar':
      return cn(
        'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors [&_svg]:size-4',
        active
          ? 'bg-[color:var(--color-brand-soft)] font-medium text-[color:var(--color-brand-strong)]'
          : 'text-[color:var(--color-ink-muted)] hover:bg-[color:var(--color-surface-muted)] hover:text-[color:var(--color-ink)]',
      );
    case 'rail':
      return cn(
        'flex w-full flex-col items-center gap-1 rounded-lg px-1 py-2 text-[11px] font-medium leading-tight [&_svg]:size-5',
        active
          ? 'bg-[color:var(--color-brand-soft)] text-[color:var(--color-brand-strong)]'
          : 'text-[color:var(--color-ink-muted)] hover:bg-[color:var(--color-surface-muted)] active:bg-[color:var(--color-surface-muted)]',
      );
    case 'tab':
      return cn(
        'flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium leading-tight [&_svg]:size-6',
        active
          ? 'text-[color:var(--color-brand)]'
          : 'text-[color:var(--color-ink-muted)] active:bg-[color:var(--color-surface-muted)]',
      );
    case 'sheet':
      return cn(
        'flex min-h-12 items-center gap-3 rounded-lg px-3 text-[15px] [&_svg]:size-5',
        active
          ? 'bg-[color:var(--color-brand-soft)] font-medium text-[color:var(--color-brand-strong)]'
          : 'text-[color:var(--color-ink)] hover:bg-[color:var(--color-surface-muted)] active:bg-[color:var(--color-surface-muted)]',
      );
  }
}

/**
 * A navigation link that knows whether it is the current page.
 *
 * `aria-current="page"` matters as much as the highlight: without it a screen-reader user
 * has no way to tell where they are in the navigation.
 */
export function NavLink({
  href,
  children,
  icon,
  exact = false,
  variant = 'sidebar',
  onClick,
}: {
  href: string;
  children: ReactNode;
  icon?: ReactNode;
  exact?: boolean | undefined;
  variant?: NavVariant;
  onClick?: () => void;
}) {
  const pathname = usePathname();
  const active = isActivePath(pathname, href, exact);

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={navClasses(variant, active)}
      {...(onClick ? { onClick } : {})}
    >
      {icon && (
        <span aria-hidden className="flex shrink-0">
          {icon}
        </span>
      )}
      <span className="max-w-full truncate">{children}</span>
    </Link>
  );
}
