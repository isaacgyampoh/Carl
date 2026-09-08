import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges class names, resolving Tailwind conflicts in favour of the last value.
 *
 * Without the merge step, `cn('px-4', 'px-6')` emits both and the winner depends on
 * stylesheet order rather than call order — which makes component variants unpredictable.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
