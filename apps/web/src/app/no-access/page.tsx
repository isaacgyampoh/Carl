import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonClasses } from '@carl/ui';
import { currentAuth } from '@/lib/auth';

export const metadata: Metadata = { title: 'No access' };

/**
 * Shown when a signed-in user has no tenant, or lacks the permission for a page.
 *
 * Deliberately says nothing about what exists. "You do not have permission to view
 * Kumasi's sales" confirms that a Kumasi branch exists; this does not.
 */
export default async function NoAccessPage() {
  const auth = await currentAuth();

  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-12">
      <div className="w-full max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight">You do not have access to this</h1>
        <p className="mt-2 text-sm text-[color:var(--color-ink-muted)]">
          {auth?.tenant
            ? 'Your role does not include this area. If you need it, ask an administrator at your business.'
            : 'Your account is not yet attached to a business. Contact whoever manages Carl for your organisation.'}
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link href="/" className={buttonClasses({ variant: 'secondary' })}>
            Back to dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
