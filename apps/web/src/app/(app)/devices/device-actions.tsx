'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button } from '@carl/ui';

import { issueActivationCode, revokeDevice } from '@/server/device-actions';

/**
 * Issuing and revoking.
 *
 * The activation code is shown **once**. Only a peppered hash is stored, so it genuinely
 * cannot be retrieved afterwards — the UI says so plainly rather than letting an installer
 * assume they can come back for it.
 */
export function DeviceActions({
  deviceId,
  deviceName,
  status,
}: {
  deviceId: string;
  deviceName: string;
  status: string;
}) {
  const router = useRouter();
  const [code, setCode] = useState<{ value: string; expiresAt: string } | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'REVOKED') {
    return <span className="text-xs text-[color:var(--color-ink-muted)]">Revoked</span>;
  }

  return (
    <div className="flex flex-col gap-2">
      {error && <Alert tone="danger">{error}</Alert>}

      {code && (
        <div className="border-[color:var(--color-brand)]/30 rounded-lg border bg-[color:var(--color-brand-soft)] px-3 py-2">
          <p className="text-xs font-medium text-[color:var(--color-brand-strong)]">
            Activation code — shown once
          </p>
          <p className="font-mono text-lg font-semibold tracking-wider">{code.value}</p>
          <p className="mt-0.5 text-xs text-[color:var(--color-ink-muted)]">
            Expires {new Date(code.expiresAt).toLocaleString('en-GH')}. It cannot be shown again;
            issue a new one if it is lost.
          </p>
        </div>
      )}

      {!confirmingRevoke ? (
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void issueActivationCode({ deviceId }).then((result) => {
                setBusy(false);
                if (!result.ok) {
                  setError(result.message);
                  return;
                }
                setCode({ value: result.data.code, expiresAt: result.data.expiresAt });
                router.refresh();
              });
            }}
          >
            {status === 'PENDING' ? 'Issue code' : 'Re-issue code'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmingRevoke(true)}>
            Revoke
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-[color:var(--color-ink-muted)]">
            Revoking stops {deviceName} at its next check, even if it is offline. This cannot be
            undone.
          </p>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason (required)"
            aria-label="Reason for revoking"
            className="h-9 rounded-md border border-[color:var(--color-border)] px-2 text-sm"
          />
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmingRevoke(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={busy}
              disabled={reason.trim().length < 3}
              onClick={() => {
                setBusy(true);
                setError(null);
                void revokeDevice({ deviceId, reason: reason.trim() }).then((result) => {
                  setBusy(false);
                  if (!result.ok) {
                    setError(result.message);
                    return;
                  }
                  setConfirmingRevoke(false);
                  router.refresh();
                });
              }}
            >
              Revoke terminal
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
