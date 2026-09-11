import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../cn';

/**
 * Buttons.
 *
 * Sizing is driven by where Carl is used. `pos` exists because a cashier hits these with a
 * thumb on a greasy resistive panel while a queue waits: 56px tall, which is above the
 * 44px minimum every touch guideline gives and well above what a desktop-first component
 * library would produce.
 *
 * Transitions are limited to colour. A POS button that animates its size or shadow reads
 * as lag on the low-powered hardware these run on.
 */
export const buttonClasses = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg',
    'font-medium transition-colors duration-100',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-brand)]',
    'disabled:pointer-events-none disabled:opacity-50',
    // Stops a double-tap from selecting the label text on a touch panel.
    'select-none touch-manipulation',
  ],
  {
    variants: {
      variant: {
        primary:
          'bg-[color:var(--color-brand)] text-white hover:bg-[color:var(--color-brand-strong)] active:bg-[color:var(--color-brand-strong)]',
        secondary:
          'border border-[color:var(--color-border)] bg-[color:var(--color-surface)] text-[color:var(--color-ink)] hover:bg-[color:var(--color-surface-muted)]',
        ghost:
          'text-[color:var(--color-ink-muted)] hover:bg-[color:var(--color-surface-muted)] hover:text-[color:var(--color-ink)]',
        // Reserved for actions that destroy or reverse something. Used sparingly, so it
        // still reads as a warning when it appears.
        danger: 'bg-[color:var(--color-danger)] text-white hover:opacity-90',
        positive: 'bg-[color:var(--color-positive)] text-white hover:opacity-90',
      },
      // On a touch screen the compact sizes grow to the 44px minimum a finger needs; a mouse
      // keeps the desktop density.
      size: {
        sm: 'h-8 px-3 text-sm pointer-coarse:h-10',
        md: 'h-10 px-4 text-sm pointer-coarse:h-11',
        lg: 'h-12 px-6 text-base',
        pos: 'h-14 px-6 text-lg font-semibold',
        icon: 'size-10 pointer-coarse:size-12',
      },
      block: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'primary', size: 'md', block: false },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonClasses> {
  /** Renders a spinner and blocks interaction. Prevents a double-submitted sale. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, block, loading, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(buttonClasses({ variant, size, block }), className)}
      disabled={disabled ?? loading}
      // Announces the busy state to assistive technology, which a spinner alone does not.
      aria-busy={loading}
      {...props}
    >
      {loading && (
        <span
          aria-hidden
          className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
});

/**
 * Button styling for elements that are not buttons.
 *
 * A link that looks like a button must still be an `<a>`: wrapping one in a `<button>`
 * produces invalid nesting and breaks middle-click, open-in-new-tab and the browser's own
 * link affordances. Use this on the anchor instead.
 *
 *   <Link href="/x" className={buttonClasses({ variant: 'secondary' })}>Back</Link>
 */
export type ButtonClassOptions = VariantProps<typeof buttonClasses>;
