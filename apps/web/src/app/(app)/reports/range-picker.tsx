import Link from 'next/link';
import { cn } from '@carl/ui';

/**
 * Date ranges.
 *
 * Resolved on the server rather than in the browser so the boundaries are computed once,
 * and so a report link can be shared and reproduce the same figures.
 *
 * Ranges are half-open (`from <= sold_at < to`), which is what stops a sale at exactly
 * midnight being counted in two adjacent periods.
 */
export type RangeKey = 'today' | 'yesterday' | 'week' | 'month' | 'custom';

const OPTIONS: readonly { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
];

export function resolveRange(
  range: string | undefined,
  fromParam: string | undefined,
  toParam: string | undefined,
): { from: string; to: string; label: string; key: RangeKey } {
  const now = new Date();
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

  switch (range) {
    case 'yesterday': {
      const start = startOfDay(new Date(now.getTime() - 86_400_000));
      const end = startOfDay(now);
      return {
        from: start.toISOString(),
        to: end.toISOString(),
        label: 'Yesterday',
        key: 'yesterday',
      };
    }
    case 'week': {
      // Weeks start on Monday, which is how a shop's trading week is discussed.
      const day = (now.getDay() + 6) % 7;
      const start = startOfDay(new Date(now.getTime() - day * 86_400_000));
      const end = new Date(startOfDay(now).getTime() + 86_400_000);
      return { from: start.toISOString(), to: end.toISOString(), label: 'This week', key: 'week' };
    }
    case 'month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(startOfDay(now).getTime() + 86_400_000);
      return {
        from: start.toISOString(),
        to: end.toISOString(),
        label: 'This month',
        key: 'month',
      };
    }
    case undefined:
      // No range in the URL: fall through to today, below.
      break;
    case 'custom': {
      if (fromParam && toParam) {
        return {
          from: new Date(fromParam).toISOString(),
          to: new Date(new Date(toParam).getTime() + 86_400_000).toISOString(),
          label: `${fromParam} to ${toParam}`,
          key: 'custom',
        };
      }
      break;
    }
    default:
      break;
  }

  const start = startOfDay(now);
  return {
    from: start.toISOString(),
    to: new Date(start.getTime() + 86_400_000).toISOString(),
    label: 'Today',
    key: 'today',
  };
}

export function RangePicker({ current }: { current: RangeKey }) {
  return (
    <nav aria-label="Report period" className="flex flex-wrap gap-2">
      {OPTIONS.map((option) => (
        <Link
          key={option.key}
          href={`/reports?range=${option.key}`}
          aria-current={current === option.key ? 'page' : undefined}
          className={cn(
            'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
            current === option.key
              ? 'border-[color:var(--color-brand)] bg-[color:var(--color-brand-soft)] text-[color:var(--color-brand-strong)]'
              : 'border-[color:var(--color-border)] hover:bg-[color:var(--color-surface-muted)]',
          )}
        >
          {option.label}
        </Link>
      ))}
    </nav>
  );
}
