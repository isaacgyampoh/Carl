import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../cn';

const badge = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'bg-[color:var(--color-surface-muted)] text-[color:var(--color-ink-muted)]',
        brand: 'bg-[color:var(--color-brand-soft)] text-[color:var(--color-brand-strong)]',
        positive: 'bg-[color:var(--color-positive)]/12 text-[color:var(--color-positive)]',
        warning: 'bg-[color:var(--color-warning)]/15 text-[color:var(--color-warning)]',
        danger: 'bg-[color:var(--color-danger)]/12 text-[color:var(--color-danger)]',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badge> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}

/**
 * Maps a domain status to a visual tone.
 *
 * Centralised so SUSPENDED never reads as green in one screen and red in another —
 * inconsistent status colour is how an operator misreads a dashboard at a glance.
 */
export function statusTone(status: string): NonNullable<BadgeProps['tone']> {
  switch (status) {
    case 'ACTIVE':
    case 'COMPLETED':
    case 'RECEIVED':
    case 'APPROVED':
    case 'PAID':
    case 'RESOLVED':
    case 'ONLINE':
      return 'positive';
    case 'TRIAL':
    case 'IN_PROGRESS':
    case 'ORDERED':
    case 'REQUESTED':
    case 'PENDING':
      return 'brand';
    case 'GRACE_PERIOD':
    case 'PAST_DUE':
    case 'PENDING_APPROVAL':
    case 'PARTIALLY_RECEIVED':
    case 'PARTIAL':
    case 'OFFLINE':
    case 'IN_TRANSIT':
      return 'warning';
    case 'SUSPENDED':
    case 'CANCELLED':
    case 'REVOKED':
    case 'VOIDED':
    case 'REJECTED':
    case 'EXPIRED':
    case 'UNPAID':
      return 'danger';
    default:
      return 'neutral';
  }
}
