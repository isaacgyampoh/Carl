import type { ReactNode } from 'react';
import { cn } from '../cn';

/**
 * An inline message.
 *
 * `role="alert"` on the error tone so a failure that appears after an action is announced
 * rather than silently rendered — the case that matters is a cashier who has just tapped
 * Complete and needs to know it did not.
 */
export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'positive';
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  const styles = {
    info: 'border-[color:var(--color-brand)]/25 bg-[color:var(--color-brand-soft)] text-[color:var(--color-brand-strong)]',
    warning:
      'border-[color:var(--color-warning)]/30 bg-[color:var(--color-warning)]/10 text-[color:var(--color-ink)]',
    danger:
      'border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/8 text-[color:var(--color-danger)]',
    positive:
      'border-[color:var(--color-positive)]/30 bg-[color:var(--color-positive)]/8 text-[color:var(--color-positive)]',
  }[tone];

  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className={cn('rounded-lg border px-4 py-3 text-sm', styles, className)}
    >
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={cn(title && 'mt-0.5')}>{children}</div>}
    </div>
  );
}
