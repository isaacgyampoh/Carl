import type { ReactNode } from 'react';

/** A consistent heading for every list and detail screen. */
export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  // `| undefined` is required under exactOptionalPropertyTypes: callers legitimately pass
  // a value that may be undefined, and without this they would have to spread-conditionally
  // at every call site.
  description?: string | undefined;
  action?: ReactNode | undefined;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-0.5 text-sm text-[color:var(--color-ink-muted)]">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
