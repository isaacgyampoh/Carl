'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatMoney, formatQuantity, parseMoney } from '@carl/shared';
import { Alert, Button, Card, CardBody, CardHeader } from '@carl/ui';

import { receivePurchase } from '@/server/purchasing-actions';

interface OutstandingLine {
  productId: string;
  name: string;
  outstanding: number;
  unitCost: number;
}

/**
 * Receiving a delivery.
 *
 * Quantities default to what is still outstanding, because a full delivery is the common
 * case and typing the same number again is friction. Deliveries arrive short, though, so
 * each line is editable — and receiving less does not close the order.
 *
 * The cost is editable too: what the supplier actually charged this time is what should
 * feed the weighted average, not what the order assumed.
 */
export function ReceivePurchase({
  purchaseId,
  lines,
}: {
  purchaseId: string;
  lines: OutstandingLine[];
}) {
  const router = useRouter();
  const [quantities, setQuantities] = useState<Record<string, number>>(
    Object.fromEntries(lines.map((line) => [line.productId, line.outstanding])),
  );
  const [costs, setCosts] = useState<Record<string, number>>(
    Object.fromEntries(lines.map((line) => [line.productId, line.unitCost])),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const receiving = lines.filter((line) => (quantities[line.productId] ?? 0) > 0);
  const total = receiving.reduce(
    (sum, line) =>
      sum + Math.round((quantities[line.productId] ?? 0) * (costs[line.productId] ?? 0)),
    0,
  );

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await receivePurchase({
      purchaseId,
      items: receiving.map((line) => ({
        productId: line.productId,
        quantity: quantities[line.productId] ?? 0,
        unitCost: costs[line.productId] ?? 0,
      })),
    });

    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  }

  return (
    <Card>
      <CardHeader
        title="Receive delivery"
        description="Stock and cost prices update together, in one transaction."
      />
      <CardBody className="flex flex-col gap-3">
        {error && <Alert tone="danger">{error}</Alert>}

        <ul className="flex flex-col gap-3">
          {lines.map((line) => (
            <li key={line.productId} className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{line.name}</span>
              <span className="text-xs text-[color:var(--color-ink-muted)]">
                {formatQuantity(Math.round(line.outstanding * 1000))} still outstanding
              </span>
              <div className="flex gap-2">
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={quantities[line.productId] ?? 0}
                  onChange={(event) =>
                    setQuantities((current) => ({
                      ...current,
                      [line.productId]: Number(event.target.value),
                    }))
                  }
                  aria-label={`Quantity of ${line.name} received`}
                  className="h-9 w-24 rounded-md border border-[color:var(--color-border)] px-2 text-right tabular-nums"
                />
                <input
                  inputMode="decimal"
                  defaultValue={formatMoney(line.unitCost, 'GHS', { withSymbol: false })}
                  onBlur={(event) => {
                    try {
                      setCosts((current) => ({
                        ...current,
                        [line.productId]: parseMoney(event.target.value),
                      }));
                    } catch {
                      setError('That is not a valid cost.');
                    }
                  }}
                  aria-label={`Unit cost of ${line.name}`}
                  className="h-9 w-28 rounded-md border border-[color:var(--color-border)] px-2 text-right tabular-nums"
                />
              </div>
            </li>
          ))}
        </ul>

        <div className="flex items-baseline justify-between border-t border-[color:var(--color-border)] pt-3">
          <span className="text-sm text-[color:var(--color-ink-muted)]">Receiving</span>
          <span className="text-lg font-semibold tabular-nums">{formatMoney(total)}</span>
        </div>

        <Button
          block
          size="lg"
          loading={busy}
          disabled={receiving.length === 0}
          onClick={() => void submit()}
        >
          Receive into stock
        </Button>
      </CardBody>
    </Card>
  );
}
