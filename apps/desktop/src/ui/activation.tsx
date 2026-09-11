/**
 * Activation.
 *
 * A person is standing in a shop typing a twelve-character code off a screen or a piece of
 * paper, probably on a bad connection, probably with a queue forming. Everything here is
 * shaped by that: the code is normalised aggressively, the install id is stable so a
 * retry cannot strand them, and failures say what to do rather than what went wrong.
 */

import { useState } from 'react';

import type { Runtime } from '../app';
import { clearCashierToken, clearDeviceSecret, storeDeviceSecret } from '../lib/keychain';
import { TenantBoundary, decideRebinding } from '../lib/tenant-boundary';
import { APP_VERSION } from '../lib/env';
import { LocalSettings } from '../lib/local-settings';

const MESSAGES: Record<string, string> = {
  ACTIVATION_CODE_INVALID: 'That code was not recognised. Check it and try again.',
  ACTIVATION_CODE_EXPIRED: 'That code has expired. Ask for a new one.',
  ACTIVATION_CODE_CONSUMED: 'That code has already been used on another terminal.',
  DEVICE_REVOKED: 'This terminal has been revoked. Contact your manager.',
  TENANT_SUSPENDED: 'This business’s account is suspended.',
  NETWORK: 'Carl could not be reached. Check the connection and try again.',
};

export function Activation({
  runtime,
  onActivated,
}: {
  runtime: Runtime;
  onActivated: () => void;
}): React.JSX.Element {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Typed by hand from a screen: hyphens, spaces and lower case all arrive, and the
  // alphabet excludes I, O, 0 and 1 precisely because they are misread.
  const normalised = code.toUpperCase().replace(/[^A-Z2-9]/g, '');
  const complete = normalised.length === 12;

  async function activate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await runtime.api.activate({
        code: normalised,
        // Stable across retries: if the response is lost — normal on a shop connection —
        // retrying with the same id returns the same session rather than stranding the
        // installer with a terminal that is activated and holds no secret.
        installId: await new LocalSettings(runtime.connection).installId(),
        platform: platformName(),
        appVersion: APP_VERSION,
      });

      if (!result.ok) {
        setError(MESSAGES[result.failure.error] ?? 'Activation failed. Try again.');
        return;
      }

      const session = result.value;

      // One till serves one business. See lib/tenant-boundary.ts for why this comes before
      // anything is written.
      const previous = await runtime.devices.read();
      const boundary = new TenantBoundary(runtime.connection);
      const decision = decideRebinding(previous, session, await boundary.unsyncedCount());
      if (decision.kind === 'refuse') {
        setError(
          `This till still holds ${decision.unsynced} sale${decision.unsynced === 1 ? '' : 's'} for ` +
            `${decision.previousTenantName} that ${decision.unsynced === 1 ? 'has' : 'have'} not reached Carl. ` +
            'Connect it to the internet so they send, or contact Carl support, before it joins another business.',
        );
        return;
      }
      if (decision.kind === 'switch' && previous) {
        await boundary.wipeBusinessData();
        await clearCashierToken(previous.deviceId);
        if (previous.deviceId !== session.deviceId) await clearDeviceSecret(previous.deviceId);
      }

      // The secret goes to the OS keychain first. If the configuration were written first
      // and this failed, the terminal would look activated and be unable to prove it.
      await storeDeviceSecret(session.deviceId, session.deviceSecret);
      await runtime.devices.save({
        deviceId: session.deviceId,
        tenantId: session.tenantId,
        branchId: session.branchId,
        deviceCode: session.deviceCode,
        branchName: session.branchName,
        tenantName: session.tenantName,
        authorizedUntil: session.authorizedUntil,
        lastSyncAt: null,
        catalogueVersion: null,
        activatedAt: new Date().toISOString(),
      });

      onActivated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Activation failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ height: '100vh', display: 'grid', placeContent: 'center', padding: 32 }}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (complete && !busy) void activate();
        }}
        style={{ display: 'grid', gap: 20, width: 420 }}
      >
        <div>
          <h1 style={{ fontSize: 24, margin: '0 0 6px' }}>Set up this terminal</h1>
          <p style={{ color: 'var(--muted)', margin: 0 }}>
            Enter the activation code from Carl on the web.
          </p>
        </div>

        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="ABCD EFGH JKLM"
          autoFocus
          spellCheck={false}
          autoComplete="off"
          aria-label="Activation code"
          disabled={busy}
          style={{
            fontSize: 26,
            letterSpacing: '0.18em',
            textAlign: 'center',
            fontFamily: 'ui-monospace, monospace',
            minHeight: 60,
          }}
        />

        <p style={{ color: 'var(--muted)', margin: 0, fontSize: 14, textAlign: 'center' }}>
          {normalised.length} of 12 characters
        </p>

        {error ? (
          <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>
            {error}
          </p>
        ) : null}

        <button type="submit" className="primary" disabled={!complete || busy}>
          {busy ? 'Activating…' : 'Activate'}
        </button>
      </form>
    </main>
  );
}

function platformName(): string {
  const agent = navigator.userAgent;
  if (/Win/i.test(agent)) return 'WINDOWS';
  if (/Mac/i.test(agent)) return 'MACOS';
  return 'LINUX';
}
