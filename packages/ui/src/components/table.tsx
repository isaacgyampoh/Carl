import type { HTMLAttributes, ReactNode, ThHTMLAttributes, TdHTMLAttributes } from 'react';
import { cn } from '../cn';

/**
 * Data tables.
 *
 * The wrapper scrolls horizontally rather than letting the page do it. A table of sales
 * has more columns than a phone has width, and a horizontally scrolling *page* makes the
 * rest of the interface unusable while reading one.
 */
export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full border-collapse text-sm', className)} {...props} />
    </div>
  );
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn('border-b border-[color:var(--color-border)] text-left', className)}
      {...props}
    />
  );
}

export function TBody(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} />;
}

export function TR({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        'border-b border-[color:var(--color-border)] last:border-0',
        'hover:bg-[color:var(--color-surface-muted)]',
        className,
      )}
      {...props}
    />
  );
}

export interface CellProps {
  /** Right-aligns and applies tabular numerals. Use for every money or quantity column. */
  numeric?: boolean;
}

export function TH({
  className,
  numeric,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & CellProps) {
  return (
    <th
      scope="col"
      className={cn(
        'px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-ink-muted)]',
        numeric && 'text-right',
        className,
      )}
      {...props}
    />
  );
}

export function TD({
  className,
  numeric,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & CellProps) {
  return (
    <td
      className={cn(
        'px-4 py-3 text-[color:var(--color-ink)]',
        numeric && 'text-right tabular-nums',
        className,
      )}
      {...props}
    />
  );
}

/**
 * What a table shows when it has nothing to show.
 *
 * A blank rectangle is the most common way an interface looks broken when it is merely
 * empty. Every empty state names what is missing and, where there is one, offers the
 * action that fixes it.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      {icon && <div className="mb-1 text-[color:var(--color-ink-muted)]">{icon}</div>}
      <p className="font-medium text-[color:var(--color-ink)]">{title}</p>
      {description && (
        <p className="max-w-sm text-sm text-[color:var(--color-ink-muted)]">{description}</p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/**
 * A loading placeholder shaped like the content it replaces.
 *
 * Preferred over a spinner for tables and lists: it keeps the layout from jumping when data
 * arrives, which on a POS is the difference between tapping a button and tapping whatever
 * moved into its place.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse rounded bg-[color:var(--color-surface-muted)]', className)}
    />
  );
}
