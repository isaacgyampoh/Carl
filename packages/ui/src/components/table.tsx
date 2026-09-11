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
    <div className="w-full overflow-x-auto overscroll-x-contain">
      <table
        className={cn(
          'w-full border-collapse text-sm',
          // The first column (what the row IS) stays put while the rest scrolls, so a phone
          // reading the fifth column still knows which sale or product it belongs to.
          '[&_td:first-child]:sticky [&_td:first-child]:left-0 [&_td:first-child]:z-[1] [&_td:first-child]:bg-inherit',
          '[&_th:first-child]:sticky [&_th:first-child]:left-0 [&_th:first-child]:z-[1] [&_th:first-child]:bg-inherit',
          className,
        )}
        {...props}
      />
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
        // Opaque, so the sticky first cell can inherit it rather than show content scrolling beneath.
        'bg-[color:var(--color-surface)] hover:bg-[color:var(--color-surface-muted)]',
        className,
      )}
      {...props}
    />
  );
}

export interface CellProps {
  /** Right-aligns and applies tabular numerals. Use for every money or quantity column. */
  numeric?: boolean;
  /**
   * The narrowest screen this column is worth its width on.
   *
   * A phone is 390 points wide and a sales table has six columns, so the last of them sat off
   * the edge — reachable only by dragging the table sideways, one column at a time, past a
   * sticky first column. Marking the secondary ones drops them below the given breakpoint and
   * leaves what a shopkeeper reads at a glance: what it is, what it costs, how many are left.
   *
   * Everything hidden must be reachable elsewhere — the row's own page, or another line in the
   * first cell. A column no phone can reach is a column that does not exist.
   */
  from?: 'sm' | 'md' | 'lg';
}

/** Tailwind needs these spelled out; a computed class name is not in the stylesheet. */
const VISIBLE_FROM = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
} as const;

export function TH({
  className,
  numeric,
  from,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & CellProps) {
  return (
    <th
      scope="col"
      className={cn(
        'whitespace-nowrap px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-ink-muted)] sm:px-4',
        numeric && 'text-right',
        from && VISIBLE_FROM[from],
        className,
      )}
      {...props}
    />
  );
}

export function TD({
  className,
  numeric,
  from,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & CellProps) {
  return (
    <td
      className={cn(
        // One line per row on a phone: the table scrolls sideways, so wrapping only made each
        // row three lines tall and split references like S-00412 across two.
        'px-3 py-3 text-[color:var(--color-ink)] max-md:whitespace-nowrap sm:px-4',
        numeric && 'whitespace-nowrap text-right tabular-nums',
        from && VISIBLE_FROM[from],
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
