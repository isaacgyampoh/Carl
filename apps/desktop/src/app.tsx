/**
 * Carl Desktop.
 *
 * Three states, and the order matters:
 *
 *   1. Not activated     -> the activation screen. Nothing else is reachable.
 *   2. No cashier        -> sign-in. The device secret proves which till this is; it does
 *                           not prove who is standing at it, and a sale needs both.
 *   3. Signed in         -> the till.
 *   4. Out of window     -> the till is locked until it reaches the server again.
 *
 * (3) is the one worth stating plainly: a terminal that has not contacted Carl within its
 * offline grace period stops selling. That is what bounds the usefulness of a stolen till,
 * and it is enforced by the server refusing to sync as well as here, so a tampered local
 * database buys nothing.
 */

import { useCallback, useEffect, useState } from 'react';
import { SqliteSyncQueue } from '@carl/sync';

import { CashierSession, type Cashier } from './lib/cashier-session';
import { CatalogueStore } from './lib/catalogue-store';
import { CARL_URL, SUPABASE_ANON_KEY, SUPABASE_URL } from './lib/env';
import { DeviceApi } from './lib/device-api';
import { DeviceStore, type DeviceConfig } from './lib/device-store';
import { readDeviceSecret } from './lib/keychain';
import { TauriSqliteConnection } from './lib/tauri-sqlite';
import { Activation } from './ui/activation';
import { SignIn } from './ui/sign-in';
import { Terminal } from './ui/terminal';

export interface Runtime {
  readonly connection: TauriSqliteConnection;
  readonly queue: SqliteSyncQueue;
  readonly catalogue: CatalogueStore;
  readonly devices: DeviceStore;
  readonly api: DeviceApi;
}

type State =
  | { status: 'starting' }
  | { status: 'failed'; detail: string }
  | { status: 'activating'; runtime: Runtime }
  | {
      status: 'signing-in';
      runtime: Runtime;
      config: DeviceConfig;
      secret: string;
      session: CashierSession;
    }
  | {
      status: 'ready';
      runtime: Runtime;
      config: DeviceConfig;
      secret: string;
      session: CashierSession;
      cashier: Cashier;
    };

export function App(): React.JSX.Element {
  const [state, setState] = useState<State>({ status: 'starting' });

  const start = useCallback(async () => {
    try {
      const connection = await TauriSqliteConnection.open();
      const queue = new SqliteSyncQueue(connection);
      // Idempotent, and run on every start: a terminal updated after months offline brings
      // its local database forward before anything reads from it.
      await queue.migrate();

      const runtime: Runtime = {
        connection,
        queue,
        catalogue: new CatalogueStore(connection),
        devices: new DeviceStore(connection),
        api: new DeviceApi({ baseUrl: CARL_URL }),
      };

      const config = await runtime.devices.read();
      if (!config) {
        setState({ status: 'activating', runtime });
        return;
      }

      // The configuration says which terminal this is; the keychain says whether it can
      // still prove it. A config row without a secret means someone cleared the keychain,
      // and the terminal must be activated again rather than pretending it is authorised.
      const secret = await readDeviceSecret(config.deviceId);
      if (!secret) {
        setState({ status: 'activating', runtime });
        return;
      }

      const session = new CashierSession({
        supabaseUrl: SUPABASE_URL,
        anonKey: SUPABASE_ANON_KEY,
        deviceId: config.deviceId,
      });

      // Restores the previous shift if its token is still good, so a terminal restarted
      // mid-shift does not make a queue of customers wait for a password.
      const cashier = await session.restore();
      setState(
        cashier
          ? { status: 'ready', runtime, config, secret, session, cashier }
          : { status: 'signing-in', runtime, config, secret, session },
      );
    } catch (error) {
      setState({
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  if (state.status === 'starting') {
    return <Splash message="Starting Carl…" />;
  }

  if (state.status === 'failed') {
    return (
      <Splash
        message="Carl could not open its local database."
        detail={state.detail}
        // No "continue anyway": without the local database a sale cannot be written down
        // before the receipt prints, and a till that takes money it cannot record is worse
        // than a till that will not open.
        action={{ label: 'Try again', onClick: () => void start() }}
      />
    );
  }

  if (state.status === 'activating') {
    return <Activation runtime={state.runtime} onActivated={() => void start()} />;
  }

  if (state.status === 'signing-in') {
    return (
      <SignIn
        session={state.session}
        branchName={state.config.branchName}
        tenantName={state.config.tenantName}
        onSignedIn={(cashier) => setState({ ...state, status: 'ready', cashier })}
      />
    );
  }

  return (
    <Terminal
      runtime={state.runtime}
      config={state.config}
      secret={state.secret}
      session={state.session}
      cashier={state.cashier}
      onSignOut={() => {
        void state.session.signOut().then(() => start());
      }}
    />
  );
}

function Splash({
  message,
  detail,
  action,
}: {
  message: string;
  detail?: string;
  action?: { label: string; onClick: () => void };
}): React.JSX.Element {
  return (
    <main
      style={{
        height: '100vh',
        display: 'grid',
        placeContent: 'center',
        textAlign: 'center',
        gap: 16,
        padding: 32,
      }}
    >
      <h1 style={{ fontSize: 22, margin: 0 }}>{message}</h1>
      {detail ? <p style={{ color: 'var(--muted)', maxWidth: 460 }}>{detail}</p> : null}
      {action ? (
        <button className="primary" onClick={action.onClick} style={{ justifySelf: 'center' }}>
          {action.label}
        </button>
      ) : null}
    </main>
  );
}
