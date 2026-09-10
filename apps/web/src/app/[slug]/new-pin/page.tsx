import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { currentAuth } from '@/lib/auth';
import { NewPinForm } from './new-pin-form';

export const metadata: Metadata = { title: 'Choose your PIN', robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * Choosing your own PIN, immediately after using one somebody else issued.
 *
 * Reached only with a valid session, so this is not a second authentication step — the
 * person is already signed in. It exists because a credential a manager knows is not a
 * credential: until they pick their own, a sale attributed to them could have been rung up
 * by whoever handed it over.
 */
export default async function NewPinPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tenant?: string }>;
}) {
  const [{ slug }, { tenant }] = await Promise.all([params, searchParams]);
  const auth = await currentAuth();
  if (!auth) redirect(`/${slug}`);
  if (!tenant) redirect('/dashboard');

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <header className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Choose your PIN</h1>
          <p className="mt-2 text-sm text-[color:var(--color-text-muted)]">
            Pick four digits only you know. You will use these to sign in from now on.
          </p>
        </header>
        <NewPinForm tenantId={tenant} />
      </div>
    </main>
  );
}
