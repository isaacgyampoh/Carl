'use client';

import { useEffect } from 'react';

/**
 * What a person sees when a page fails to render.
 *
 * This exists because of a real incident: two owner pages threw during render, Carl had no
 * boundary, and the browser fell back to its own error page — "This page couldn't load" —
 * which tells the reader nothing and looks like Carl has crashed rather than stumbled.
 *
 * It deliberately shows no error text, no digest and no stack. A cashier or a shop owner
 * can do nothing with any of it, and a message assembled from an exception is exactly how
 * "The database could not be reached." reached a screen once already. The real detail stays
 * in the server logs, where it is already recorded.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Console only, and only in the browser's own devtools. Nothing is rendered from it.
    console.error('Carl page error', { digest: error.digest });
  }, [error]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2">
          <h1 className="text-lg font-medium">Something went wrong</h1>
          <p className="text-sm text-[color:var(--color-text-muted)]">
            This page didn’t load. Nothing you were doing has been lost.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={reset}
            className="h-11 rounded-lg bg-[color:var(--color-text)] px-5 text-sm font-medium text-[color:var(--color-surface)]"
          >
            Try again
          </button>
          <a
            href="/"
            className="flex h-11 items-center justify-center rounded-lg border border-[color:var(--color-border)] px-5 text-sm font-medium"
          >
            Go back
          </a>
        </div>
      </div>
    </main>
  );
}
