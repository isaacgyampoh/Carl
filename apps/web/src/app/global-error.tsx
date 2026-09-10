'use client';

/**
 * The last resort, for a failure in the root layout itself.
 *
 * Next replaces the entire document here, so this file must render its own `<html>` and
 * `<body>` and cannot rely on any application styling, provider or font — whatever broke
 * may be the thing that would have supplied them. Everything is inline for that reason.
 */
export default function GlobalError({
  reset,
}: {
  // `error` is deliberately not destructured: nothing here renders it, and a boundary that
  // holds an exception is a boundary somebody eventually prints it from.
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          background: '#ffffff',
          color: '#111827',
        }}
      >
        <main style={{ maxWidth: '22rem', padding: '0 1.5rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.125rem', fontWeight: 500, margin: '0 0 0.5rem' }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: '0.875rem', color: '#6b7280', margin: '0 0 1.5rem' }}>
            Carl didn’t load. Nothing you were doing has been lost.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              height: '2.75rem',
              padding: '0 1.25rem',
              borderRadius: '0.5rem',
              border: 'none',
              background: '#111827',
              color: '#ffffff',
              fontSize: '0.875rem',
              fontWeight: 500,
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
