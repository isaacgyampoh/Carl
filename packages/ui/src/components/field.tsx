import { forwardRef, type InputHTMLAttributes, type ReactNode, useId } from 'react';
import { cn } from '../cn';

/**
 * A labelled form field.
 *
 * Label, input, hint and error are wired together here rather than at each call site,
 * because the wiring is what makes a form usable with a screen reader and it is exactly
 * what gets skipped under deadline. `aria-describedby` points at whichever of hint or error
 * is present, and `aria-invalid` marks the field itself.
 */
export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: string;
  error?: string | undefined;
  /** Rendered inside the input's trailing edge — a currency symbol, a unit, a clear button. */
  suffix?: ReactNode;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, suffix, className, required, ...props },
  ref,
) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-[color:var(--color-ink)]">
        {label}
        {required && (
          <span className="ml-0.5 text-[color:var(--color-danger)]" aria-hidden>
            *
          </span>
        )}
      </label>

      <div className="relative">
        <input
          ref={ref}
          id={id}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : hint ? hintId : undefined}
          className={cn(
            'h-10 w-full rounded-lg border bg-[color:var(--color-surface)] px-3 text-sm',
            'text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-muted)]',
            'transition-colors focus-visible:outline-2 focus-visible:outline-offset-0',
            error
              ? 'border-[color:var(--color-danger)] focus-visible:outline-[color:var(--color-danger)]'
              : 'border-[color:var(--color-border)] focus-visible:outline-[color:var(--color-brand)]',
            suffix && 'pr-10',
            className,
          )}
          {...props}
        />
        {suffix && (
          <div className="absolute inset-y-0 right-3 flex items-center text-sm text-[color:var(--color-ink-muted)]">
            {suffix}
          </div>
        )}
      </div>

      {error ? (
        // `role="alert"` so the message is announced when it appears after a failed submit.
        <p id={errorId} role="alert" className="text-sm text-[color:var(--color-danger)]">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-sm text-[color:var(--color-ink-muted)]">
          {hint}
        </p>
      ) : null}
    </div>
  );
});
