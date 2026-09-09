'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatMoney, parseMoney } from '@carl/shared';
import { Alert, Button, Card, CardBody, CardHeader, Field } from '@carl/ui';

import { closeSession, openSession, recordCashMovement } from '@/server/register-actions';

interface OpenSession {
  id: string;
  registerName: string;
  openedAt: string;
  openingFloat: number;
  expected: number;
}

/**
 * Opening, working and closing a drawer.
 *
 * The expected figure is shown *before* the count is entered, deliberately. Hiding it
 * until afterwards is a common design intended to stop a cashier "counting to the number",
 * but it also stops them noticing an obvious data-entry error while they still have the
 * cash in hand. The variance is recorded either way, and every session is attributable.
 */
export function RegisterPanel({
  registers,
  openSession: current,
  canClose,
  canMoveCash,
}: {
  registers: { id: string; name: string }[];
  openSession: OpenSession | null;
  canClose: boolean;
  canMoveCash: boolean;
}) {
  const router = useRouter();
  const [registerId, setRegisterId] = useState(registers[0]?.id ?? '');
  const [floatText, setFloatText] = useState('');
  const [countedText, setCountedText] = useState('');
  const [note, setNote] = useState('');
  const [movementAmount, setMovementAmount] = useState('');
  const [movementReason, setMovementReason] = useState('');
  const [movementType, setMovementType] = useState<'IN' | 'OUT' | 'DROP'>('DROP');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function amountOf(text: string): number | null {
    try {
      return parseMoney(text || '0');
    } catch {
      setError('That is not a valid amount.');
      return null;
    }
  }

  async function run(action: () => Promise<{ ok: boolean; message?: string }>): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (!result.ok) {
      setError(result.message ?? 'That could not be completed.');
      return;
    }
    setCountedText('');
    setNote('');
    setMovementAmount('');
    setMovementReason('');
    router.refresh();
  }

  if (!current) {
    return (
      <Card>
        <CardHeader title="Open a register" description="Count the float before you start." />
        <CardBody className="flex flex-col gap-3">
          {error && <Alert tone="danger">{error}</Alert>}
          {registers.length === 0 ? (
            <p className="text-sm text-[color:var(--color-ink-muted)]">
              No register is configured for this branch. An administrator can add one in settings.
            </p>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">Register</span>
                <select
                  value={registerId}
                  onChange={(event) => setRegisterId(event.target.value)}
                  className="h-10 rounded-lg border border-[color:var(--color-border)] px-3"
                >
                  {registers.map((register) => (
                    <option key={register.id} value={register.id}>
                      {register.name}
                    </option>
                  ))}
                </select>
              </label>

              <Field
                label="Opening float"
                inputMode="decimal"
                value={floatText}
                onChange={(event) => setFloatText(event.target.value)}
                hint="The cash already in the drawer."
              />

              <Button
                block
                size="lg"
                loading={busy}
                onClick={() => {
                  const amount = amountOf(floatText);
                  if (amount === null) return;
                  void run(() => openSession({ registerId, openingFloat: amount }));
                }}
              >
                Open register
              </Button>
            </>
          )}
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader
          title={current.registerName}
          description={`Open since ${new Date(current.openedAt).toLocaleTimeString('en-GH', {
            timeStyle: 'short',
          })}`}
        />
        <CardBody className="flex flex-col gap-4">
          {error && <Alert tone="danger">{error}</Alert>}

          <div className="rounded-lg bg-[color:var(--color-surface-muted)] px-4 py-3">
            <p className="text-sm text-[color:var(--color-ink-muted)]">Expected in the drawer</p>
            <p className="text-3xl font-semibold tabular-nums tracking-tight">
              {formatMoney(current.expected)}
            </p>
            <p className="mt-1 text-xs text-[color:var(--color-ink-muted)]">
              Float {formatMoney(current.openingFloat)} plus cash taken, less refunds, cash out and
              approved cash expenses. Mobile money is not included.
            </p>
          </div>

          {canClose && (
            <>
              <Field
                label="Counted in the drawer"
                inputMode="decimal"
                value={countedText}
                onChange={(event) => setCountedText(event.target.value)}
              />
              <Field
                label="Note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                hint="Required if the count differs from what is expected."
              />
              <Button
                block
                size="lg"
                loading={busy}
                disabled={countedText.trim().length === 0}
                onClick={() => {
                  const amount = amountOf(countedText);
                  if (amount === null) return;
                  void run(() =>
                    closeSession({
                      sessionId: current.id,
                      countedCash: amount,
                      ...(note.trim() ? { varianceNote: note.trim() } : {}),
                    }),
                  );
                }}
              >
                Close register
              </Button>
            </>
          )}
        </CardBody>
      </Card>

      {canMoveCash && (
        <Card>
          <CardHeader title="Move cash" description="A safe drop, a top-up, or petty cash." />
          <CardBody className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Type</span>
              <select
                value={movementType}
                onChange={(event) => setMovementType(event.target.value as 'IN' | 'OUT' | 'DROP')}
                className="h-10 rounded-lg border border-[color:var(--color-border)] px-3"
              >
                <option value="DROP">Safe drop</option>
                <option value="IN">Cash in</option>
                <option value="OUT">Cash out</option>
              </select>
            </label>
            <Field
              label="Amount"
              inputMode="decimal"
              value={movementAmount}
              onChange={(event) => setMovementAmount(event.target.value)}
            />
            <Field
              label="Reason"
              value={movementReason}
              onChange={(event) => setMovementReason(event.target.value)}
              hint="Required. Cash leaving a drawer must be explainable later."
              required
            />
            <Button
              variant="secondary"
              block
              loading={busy}
              disabled={movementReason.trim().length < 3}
              onClick={() => {
                const amount = amountOf(movementAmount);
                if (amount === null) return;
                void run(() =>
                  recordCashMovement({
                    sessionId: current.id,
                    movementType,
                    amount,
                    reason: movementReason.trim(),
                  }),
                );
              }}
            >
              Record movement
            </Button>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
