'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatQuantity } from '@carl/shared';
import { Alert, Button, Card, CardBody, CardHeader } from '@carl/ui';

import { cancelTransfer, dispatchTransfer, receiveTransfer } from '@/server/purchasing-actions';

interface Line {
  productId: string;
  name: string;
  sent: number;
}

/**
 * Moving a transfer through its states.
 *
 * Only the action valid for the current state is offered, and the wording says what will
 * physically happen — "stock leaves this branch now" rather than "approve". A transfer is
 * one of the few operations where the software's state and the goods' location can drift
 * apart, and the interface should not encourage that.
 */
export function TransferActions({
  transferId,
  status,
  canDispatch,
  canReceive,
  lines,
}: {
  transferId: string;
  status: string;
  canDispatch: boolean;
  canReceive: boolean;
  lines: Line[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'none' | 'receive' | 'cancel'>('none');
  const [received, setReceived] = useState<Record<string, number>>(
    Object.fromEntries(lines.map((line) => [line.productId, line.sent])),
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<{ ok: boolean; message?: string }>): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (!result.ok) {
      setError(result.message ?? 'That could not be completed.');
      return;
    }
    setMode('none');
    router.refresh();
  }

  const pending = ['DRAFT', 'REQUESTED', 'APPROVED'].includes(status);
  const inTransit = status === 'IN_TRANSIT';
  const done = ['RECEIVED', 'CANCELLED'].includes(status);

  if (done) {
    return (
      <Card>
        <CardHeader title="Actions" />
        <CardBody>
          <p className="text-sm text-[color:var(--color-ink-muted)]">
            This transfer is {status.toLowerCase()}. Nothing further to do.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title="Actions" />
      <CardBody className="flex flex-col gap-3">
        {error && <Alert tone="danger">{error}</Alert>}

        {mode === 'none' && pending && (
          <>
            {canDispatch ? (
              <>
                <Button
                  block
                  loading={busy}
                  onClick={() => void run(() => dispatchTransfer({ transferId }))}
                >
                  Dispatch
                </Button>
                <p className="text-xs text-[color:var(--color-ink-muted)]">
                  Stock leaves the sending branch now. It will not appear at the destination until
                  someone there receives it.
                </p>
                <Button variant="ghost" block onClick={() => setMode('cancel')}>
                  Cancel transfer
                </Button>
              </>
            ) : (
              <p className="text-sm text-[color:var(--color-ink-muted)]">
                Waiting to be dispatched by someone at the sending branch.
              </p>
            )}
          </>
        )}

        {mode === 'none' && inTransit && (
          <>
            {canReceive ? (
              <Button block onClick={() => setMode('receive')}>
                Receive delivery
              </Button>
            ) : (
              <p className="text-sm text-[color:var(--color-ink-muted)]">
                In transit. Someone at the destination branch receives it.
              </p>
            )}
          </>
        )}

        {mode === 'receive' && (
          <>
            <p className="text-xs text-[color:var(--color-ink-muted)]">
              Record what actually arrived. A shortfall is logged rather than absorbed, so a loss in
              transit can be investigated.
            </p>
            <ul className="flex flex-col gap-2">
              {lines.map((line) => (
                <li
                  key={line.productId}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="min-w-0">
                    <span className="block truncate">{line.name}</span>
                    <span className="text-xs text-[color:var(--color-ink-muted)]">
                      {formatQuantity(Math.round(line.sent * 1000))} sent
                    </span>
                  </span>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    max={line.sent}
                    value={received[line.productId] ?? 0}
                    onChange={(event) =>
                      setReceived((current) => ({
                        ...current,
                        [line.productId]: Number(event.target.value),
                      }))
                    }
                    aria-label={`Quantity of ${line.name} received`}
                    className="h-9 w-24 rounded-md border border-[color:var(--color-border)] px-2 text-right tabular-nums"
                  />
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setMode('none')} disabled={busy}>
                Back
              </Button>
              <Button
                block
                loading={busy}
                onClick={() =>
                  void run(() =>
                    receiveTransfer({
                      transferId,
                      received: lines.map((line) => ({
                        productId: line.productId,
                        quantity: received[line.productId] ?? 0,
                      })),
                    }),
                  )
                }
              >
                Receive into stock
              </Button>
            </div>
          </>
        )}

        {mode === 'cancel' && (
          <>
            <Alert tone="warning">
              Cancelling is only possible before dispatch. Once stock has left the branch the
              transfer must be received instead.
            </Alert>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Reason (required)"
              aria-label="Reason for cancelling"
              className="h-9 rounded-md border border-[color:var(--color-border)] px-2 text-sm"
            />
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setMode('none')} disabled={busy}>
                Back
              </Button>
              <Button
                variant="danger"
                block
                loading={busy}
                disabled={reason.trim().length < 3}
                onClick={() =>
                  void run(() => cancelTransfer({ transferId, reason: reason.trim() }))
                }
              >
                Cancel transfer
              </Button>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
