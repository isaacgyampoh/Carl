'use client';

import type { ReactNode } from 'react';
import type { FieldError } from 'react-hook-form';
import { Alert, cn } from '@carl/ui';

/**
 * Form building blocks shared by every create/edit screen.
 *
 * The whole point of these is that the wiring between a label, its control, its hint and
 * its error is done once. That wiring is what makes a form usable with a screen reader,
 * and it is the first thing dropped when a form is written under time pressure.
 */

export function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-[color:var(--color-border)] px-5 py-5 last:border-0">
      <div className="mb-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && (
          <p className="mt-0.5 text-sm text-[color:var(--color-ink-muted)]">{description}</p>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

export function FormRow({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={cn(wide && 'sm:col-span-2')}>{children}</div>;
}

/**
 * A labelled control.
 *
 * `error` takes React Hook Form's `FieldError` directly so a call site cannot forget to
 * unwrap `.message` and end up rendering `[object Object]` at the customer.
 */
export function LabelledField({
  label,
  hint,
  error,
  required,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: FieldError | undefined;
  required?: boolean;
  children: ReactNode;
  htmlFor: string;
}) {
  const describedBy = error ? `${htmlFor}-error` : hint ? `${htmlFor}-hint` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
        {required && (
          <span className="ml-0.5 text-[color:var(--color-danger)]" aria-hidden>
            *
          </span>
        )}
      </label>
      <div aria-describedby={describedBy}>{children}</div>
      {error ? (
        <p
          id={`${htmlFor}-error`}
          role="alert"
          className="text-sm text-[color:var(--color-danger)]"
        >
          {error.message}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="text-sm text-[color:var(--color-ink-muted)]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const inputClass =
  'h-10 w-full rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 text-sm ' +
  'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-[color:var(--color-brand)] ' +
  'aria-[invalid=true]:border-[color:var(--color-danger)]';

export const textareaClass = `${inputClass} h-auto min-h-20 py-2`;

/**
 * The error a server action returned.
 *
 * Rendered separately from field errors because it usually is not about a field: the
 * tenant is suspended, a permission is missing, a SKU is already taken. Putting it beside
 * an input would suggest the input is wrong when it is not.
 */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="px-5 pt-5">
      <Alert tone="danger">{message}</Alert>
    </div>
  );
}
