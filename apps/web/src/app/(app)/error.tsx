'use client';

import Link from 'next/link';
import { useEffect } from 'react';

/**
 * A page inside the app that failed to render.
 *
 * The root boundary replaces the whole screen, navigation included, so a cashier whose
 * reports page failed lost the way back to the till. This one renders inside the app shell:
 * the sidebar stays, and the failure is confined to the section that broke.
 *
 * Like the root boundary it shows no error text, digest or stack — nothing a shop can act
 * on, and exactly how internal messages have reached a screen before. The detail is in the
 * server logs.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Carl section error', { digest: error.digest });
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2">
          <h1 className="text-lg font-medium">This section didn’t load</h1>
          <p className="text-sm text-[color:var(--color-ink-muted)]">
            Nothing you were doing has been lost. Try again, or carry on elsewhere.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={reset}
            className="h-11 rounded-lg bg-[color:var(--color-ink)] px-5 text-sm font-medium text-[color:var(--color-surface)]"
          >
            Try again
          </button>
          <Link
            href="/dashboard"
            className="flex h-11 items-center justify-center rounded-lg border border-[color:var(--color-border)] px-5 text-sm font-medium"
          >
            Go to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
