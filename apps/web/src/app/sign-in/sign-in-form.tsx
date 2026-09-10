'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field } from '@carl/ui';
import { browserClient } from '@carl/infrastructure';

/**
 * The sign-in form.
 *
 * Every failure is reported as the same message. Distinguishing "no such account" from
 * "wrong password" turns the form into an account-enumeration oracle: an attacker learns
 * which staff email addresses are real, which is exactly what they need before trying
 * anything else.
 */
export function SignInForm({ redirectTo }: { redirectTo?: string | undefined }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function signIn(): Promise<void> {
    setSubmitting(true);
    setError(null);

    try {
      const { error: signInError } = await browserClient().auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (signInError) {
        setError('That email address and password do not match an account.');
        setSubmitting(false);
        return;
      }

      // `refresh` re-runs the server components with the new session cookie; without it
      // the destination renders against the signed-out state and bounces straight back.
      router.replace(sanitizeRedirect(redirectTo));
      router.refresh();
    } catch {
      // A network failure reaching Supabase at all. The cashier needs to know it was the
      // connection rather than their password, or they will keep retyping it.
      setError('Could not reach Carl. Check the connection and try again.');
      setSubmitting(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void signIn();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {error && <Alert tone="danger">{error}</Alert>}

      <Field
        label="Email"
        type="email"
        name="email"
        autoComplete="username"
        required
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <Field
        label="Password"
        type="password"
        name="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />

      <Button type="submit" size="lg" block loading={submitting}>
        Sign in
      </Button>
    </form>
  );
}

/**
 * Confines the post-sign-in redirect to this application.
 *
 * `?next=` comes from the URL and is therefore attacker-controlled. Without this, a link to
 * `/sign-in?next=https://evil.example` would send a freshly-authenticated user off-site —
 * a textbook open redirect, and a convincing one because the user has just typed their
 * password into a page that genuinely was Carl.
 */
function sanitizeRedirect(target: string | undefined): string {
  if (!target) return '/dashboard';
  // Must be a path, not a URL, and not a protocol-relative "//host" which browsers treat
  // as absolute.
  if (!target.startsWith('/') || target.startsWith('//')) return '/dashboard';
  return target;
}
