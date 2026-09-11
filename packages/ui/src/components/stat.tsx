import type { ReactNode } from 'react';
import { cn } from '../cn';

/**
 * A dashboard figure.
 *
 * The value uses tabular numerals so a column of amounts aligns on the decimal point.
 * Proportional digits make a list of money genuinely harder to scan, and a shop owner
 * reads these by comparing them down the column.
 */
export function Stat({
  label,
  value,
  delta,
  hint,
  tone = 'neutral',
  className,
}: {
  label: string;
  value: ReactNode;
  /** A period-on-period change. Omit it rather than showing a meaningless 0%. */
  delta?: { value: string; direction: 'up' | 'down' | 'flat' };
  hint?: string;
  tone?: 'neutral' | 'positive' | 'warning' | 'danger';
  className?: string;
}) {
  const toneClass = {
    neutral: 'text-[color:var(--color-ink)]',
    positive: 'text-[color:var(--color-positive)]',
    warning: 'text-[color:var(--color-warning)]',
    danger: 'text-[color:var(--color-danger)]',
  }[tone];

  return (
    <div
      className={cn(
        'rounded-[var(--radius-card)] border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-4 py-3.5 sm:px-5 sm:py-4',
        className,
      )}
    >
      <p className="text-sm font-medium text-[color:var(--color-ink-muted)]">{label}</p>
      <p
        className={cn(
          'mt-1 text-lg font-semibold tabular-nums tracking-tight sm:text-2xl',
          toneClass,
        )}
      >
        {value}
      </p>
      {(delta ?? hint) && (
        <p className="mt-1 flex items-center gap-1.5 text-sm text-[color:var(--color-ink-muted)]">
          {delta && (
            <span
              className={cn(
                'font-medium tabular-nums',
                delta.direction === 'up' && 'text-[color:var(--color-positive)]',
                delta.direction === 'down' && 'text-[color:var(--color-danger)]',
              )}
            >
              {delta.direction === 'up' ? '↑' : delta.direction === 'down' ? '↓' : '→'}{' '}
              {delta.value}
            </span>
          )}
          {hint}
        </p>
      )}
    </div>
  );
}
