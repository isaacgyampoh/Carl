import type { Metadata } from 'next';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

/**
 * Sign in.
 *
 * There is deliberately no "create an account" link. Carl accounts are provisioned by the
 * platform when a business is set up — self-registration would let anyone create a tenant,
 * and `enable_signup` is off in the Supabase configuration to enforce that at the source.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">Carl</h1>
          <p className="mt-1 text-sm text-[color:var(--color-ink-muted)]">
            Sign in to your business account.
          </p>
        </div>

        <SignInForm redirectTo={next} />

        <p className="mt-8 text-xs text-[color:var(--color-ink-muted)]">
          Accounts are created by your administrator. If you cannot sign in, contact whoever manages
          Carl for your business.
        </p>
      </div>
    </main>
  );
}
