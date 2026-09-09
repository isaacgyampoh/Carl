/**
 * Cashier sign-in.
 *
 * The device secret proves which till this is. This proves who is standing at it — and
 * both are required, because a sale is attributed to a person and the database checks that
 * person's permissions at that branch.
 *
 * Requires the network. Selling does not: once a shift has started, the connection can go
 * and the till keeps working.
 */

import { useState } from 'react';

import type { Cashier, CashierSession } from '../lib/cashier-session';

export function SignIn({
  session,
  branchName,
  tenantName,
  onSignedIn,
}: {
  session: CashierSession;
  branchName: string;
  tenantName: string;
  onSignedIn: (cashier: Cashier) => void;
}): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await session.signIn(email.trim(), password);
      if (result.ok) {
        onSignedIn(result.cashier);
        return;
      }
      setError(result.detail);
    } catch {
      // Sign-in is the one thing that genuinely needs the network, so say that rather than
      // showing a credential error for a connection problem.
      setError('Carl could not be reached. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ height: '100vh', display: 'grid', placeContent: 'center', padding: 32 }}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void submit();
        }}
        style={{ display: 'grid', gap: 16, width: 380 }}
      >
        <div>
          <h1 style={{ fontSize: 24, margin: '0 0 4px' }}>Sign in</h1>
          <p style={{ color: 'var(--muted)', margin: 0 }}>
            {tenantName} · {branchName}
          </p>
        </div>

        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="username"
          autoFocus
          disabled={busy}
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          disabled={busy}
        />

        {error ? (
          <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>
            {error}
          </p>
        ) : null}

        <button type="submit" className="primary" disabled={busy || !email || !password}>
          {busy ? 'Signing in…' : 'Start shift'}
        </button>
      </form>
    </main>
  );
}
