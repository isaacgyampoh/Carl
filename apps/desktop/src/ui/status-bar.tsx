/**
 * What the cashier needs to know without asking.
 *
 * Three facts, permanently visible: which branch this terminal sells for, whether Carl is
 * reachable, and how many sales have not yet reached the server. The third matters most —
 * a shop that does not know it has been offline for a day reconciles against a figure that
 * is missing a day of takings, and only finds out much later.
 */

import { useEffect, useState } from 'react';

import type { DeviceConfig } from '../lib/device-store';

export function StatusBar({
  config,
  pendingCount,
  onSync,
}: {
  config: DeviceConfig;
  pendingCount: number;
  onSync: () => void;
}): React.JSX.Element {
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  // The offline window, stated in plain terms while it still matters. A terminal that
  // stops mid-queue with no warning looks broken; one that says "3 hours left" gets
  // reconnected.
  const hoursLeft = config.authorizedUntil
    ? Math.floor((new Date(config.authorizedUntil).getTime() - Date.now()) / 3_600_000)
    : null;
  const expiring = hoursLeft !== null && hoursLeft <= 6;

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '10px 16px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
      }}
    >
      <strong>{config.tenantName}</strong>
      <span style={{ color: 'var(--muted)' }}>
        {config.branchName} · {config.deviceCode}
      </span>

      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
        {expiring ? (
          <span style={{ color: 'var(--warning)' }}>
            {hoursLeft <= 0
              ? 'Offline limit reached — reconnect to keep selling'
              : `Offline limit in ${hoursLeft}h`}
          </span>
        ) : null}

        <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span
            aria-hidden
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: online ? 'var(--ok)' : 'var(--muted)',
            }}
          />
          {online ? 'Online' : 'Offline'}
        </span>

        {pendingCount > 0 ? (
          <button onClick={onSync} title="Send queued sales now">
            {pendingCount} to send
          </button>
        ) : (
          <span style={{ color: 'var(--muted)' }}>All sales sent</span>
        )}
      </span>
    </header>
  );
}
