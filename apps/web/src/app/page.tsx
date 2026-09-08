import Link from 'next/link';

/**
 * Placeholder landing page.
 *
 * Replaced in Phase 3 by the authenticated shell. It exists now so the production build gate
 * is meaningful from Phase 0 onward rather than passing vacuously.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Carl</h1>
        <p className="mt-2 text-[color:var(--color-ink-muted)]">
          Point of sale, inventory and business management for multi-branch retail.
        </p>
      </div>
      <p className="text-sm text-[color:var(--color-ink-muted)]">
        This deployment is being built in phases. See{' '}
        <Link className="text-[color:var(--color-brand)] underline" href="/api/health">
          /api/health
        </Link>{' '}
        for service status.
      </p>
    </main>
  );
}
