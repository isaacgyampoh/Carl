import Link from 'next/link';

/**
 * An address that does not exist.
 *
 * Without this, Next served its own bare 404 — unstyled, and indistinguishable from Carl
 * being down. It says nothing about why the page is missing: a business address that does
 * not resolve must look the same as any other wrong URL, so this cannot be used to probe
 * which businesses are on Carl.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2">
          <p className="text-sm font-medium text-[color:var(--color-text-muted)]">404</p>
          <h1 className="text-lg font-medium">Page not found</h1>
          <p className="text-sm text-[color:var(--color-text-muted)]">
            The address may be mistyped, or the page has moved.
          </p>
        </div>
        <Link
          href="/"
          className="inline-flex h-11 items-center justify-center rounded-lg border border-[color:var(--color-border)] px-5 text-sm font-medium"
        >
          Go to Carl
        </Link>
      </div>
    </main>
  );
}
