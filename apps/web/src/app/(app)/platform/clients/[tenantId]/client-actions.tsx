'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Field, buttonClasses } from '@carl/ui';
import { formatMoney, type Currency } from '@carl/shared';

import {
  issueInvoice,
  reactivateTenant,
  recordSubscriptionPayment,
  suspendTenant,
} from '@/server/platform-actions';

interface OpenInvoice {
  id: string;
  number: string;
  amount: number;
}

type Panel = 'payment' | 'invoice' | 'suspend' | null;

/**
 * The operator's actions on one client.
 *
 * Inline panels rather than modals: this is used one-handed on a phone while standing in
 * front of somebody, and a modal that traps focus on a small screen is harder to escape
 * than a section that simply collapses.
 */
export function ClientActions({
  tenantId,
  tenantName,
  status,
  subscriptionId,
  defaultAmount,
  currencyCode,
  openInvoices,
}: {
  tenantId: string;
  tenantName: string;
  status: string;
  subscriptionId: string | null;
  defaultAmount: number;
  currencyCode: Currency;
  openInvoices: OpenInvoice[];
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /*
   * Minted once per opening of the payment panel, not per submit.
   *
   * That is the whole point: if the operator presses the button twice, or a request times
   * out and they retry, the same key reaches the server and the second call returns the
   * first payment instead of creating another one. Generating it inside the submit handler
   * would defeat the guarantee in exactly the case it exists for.
   */
  const [paymentKey, setPaymentKey] = useState(() => crypto.randomUUID().replace(/-/g, ''));

  function openPayment() {
    setPaymentKey(crypto.randomUUID().replace(/-/g, ''));
    setError(null);
    setNotice(null);
    setPanel(panel === 'payment' ? null : 'payment');
  }

  async function run(work: () => Promise<{ ok: boolean; message?: string }>, success: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const outcome = await work();
    setBusy(false);
    if (outcome.ok) {
      setNotice(success);
      setPanel(null);
      router.refresh();
    } else {
      setError(outcome.message ?? 'That did not work.');
    }
  }

  async function submitPayment(formData: FormData) {
    await run(
      () =>
        recordSubscriptionPayment({
          subscriptionId,
          amount: Math.round(Number(formData.get('amount')) * 100),
          method: formData.get('method'),
          reference: (formData.get('reference') as string) || undefined,
          paidAt: (formData.get('paidAt') as string) || undefined,
          invoiceId: (formData.get('invoiceId') as string) || undefined,
          idempotencyKey: paymentKey,
        }),
      'Payment recorded.',
    );
  }

  return (
    <section className="space-y-3">
      {error && (
        <Alert tone="danger" title="That did not work">
          {error}
        </Alert>
      )}
      {notice && <Alert tone="positive" title={notice} />}

      <div className="flex flex-wrap gap-2">
        {subscriptionId && (
          <>
            <button
              type="button"
              onClick={openPayment}
              className={buttonClasses({ variant: 'primary' })}
            >
              Record payment
            </button>
            <button
              type="button"
              onClick={() => setPanel(panel === 'invoice' ? null : 'invoice')}
              className={buttonClasses({ variant: 'secondary' })}
            >
              Issue invoice
            </button>
          </>
        )}
        {status === 'SUSPENDED' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => reactivateTenant({ tenantId }), 'Business reactivated.')}
            className={buttonClasses({ variant: 'secondary' })}
          >
            Reactivate
          </button>
        ) : (
          status !== 'CANCELLED' && (
            <button
              type="button"
              onClick={() => setPanel(panel === 'suspend' ? null : 'suspend')}
              className={buttonClasses({ variant: 'ghost' })}
            >
              Suspend
            </button>
          )
        )}
      </div>

      {panel === 'payment' && subscriptionId && (
        <form
          action={submitPayment}
          className="space-y-4 rounded-[var(--radius-card)] border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={`Amount (${currencyCode})`}>
              <input
                name="amount"
                type="number"
                step="0.01"
                min="0.01"
                required
                inputMode="decimal"
                defaultValue={(defaultAmount / 100).toFixed(2)}
                className={inputClass}
              />
            </Field>
            <Field label="Method">
              <select name="method" defaultValue="MOMO" className={inputClass}>
                <option value="MOMO">Mobile money</option>
                <option value="CASH">Cash</option>
                <option value="BANK_TRANSFER">Bank transfer</option>
                <option value="CARD">Card</option>
                <option value="OTHER">Other</option>
              </select>
            </Field>
            <Field label="Reference" hint="Transaction or slip number.">
              <input name="reference" className={inputClass} />
            </Field>
            <Field label="Paid on">
              <input
                name="paidAt"
                type="date"
                defaultValue={new Date().toISOString().slice(0, 10)}
                className={inputClass}
              />
            </Field>
          </div>
          {openInvoices.length > 0 && (
            <Field label="Settles invoice" hint="Optional.">
              <select name="invoiceId" defaultValue="" className={inputClass}>
                <option value="">None</option>
                {openInvoices.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.number} — {formatMoney(i.amount, currencyCode)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <button
            type="submit"
            disabled={busy}
            className={buttonClasses({ variant: 'primary', className: 'w-full sm:w-auto' })}
          >
            {busy ? 'Recording…' : 'Record payment'}
          </button>
        </form>
      )}

      {panel === 'invoice' && subscriptionId && (
        <form
          action={async (formData) => {
            await run(
              () =>
                issueInvoice({
                  subscriptionId,
                  amount: formData.get('amount')
                    ? Math.round(Number(formData.get('amount')) * 100)
                    : undefined,
                  notes: (formData.get('notes') as string) || undefined,
                }),
              'Invoice issued.',
            );
          }}
          className="space-y-4 rounded-[var(--radius-card)] border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4"
        >
          <Field label={`Amount (${currencyCode})`} hint="Defaults to the subscription price.">
            <input
              name="amount"
              type="number"
              step="0.01"
              min="0.01"
              inputMode="decimal"
              defaultValue={(defaultAmount / 100).toFixed(2)}
              className={inputClass}
            />
          </Field>
          <Field label="Notes">
            <input name="notes" className={inputClass} />
          </Field>
          <button
            type="submit"
            disabled={busy}
            className={buttonClasses({ variant: 'primary', className: 'w-full sm:w-auto' })}
          >
            {busy ? 'Issuing…' : 'Issue invoice'}
          </button>
        </form>
      )}

      {panel === 'suspend' && (
        <form
          action={async (formData) => {
            await run(
              () => suspendTenant({ tenantId, reason: formData.get('reason') }),
              'Business suspended.',
            );
          }}
          className="space-y-4 rounded-[var(--radius-card)] border border-[color:var(--color-danger)] bg-[color:var(--color-surface)] p-4"
        >
          <p className="text-sm">
            {tenantName} will not be able to sell until it is reactivated. The reason is recorded.
          </p>
          <Field label="Reason">
            <input name="reason" required minLength={5} className={inputClass} />
          </Field>
          <button
            type="submit"
            disabled={busy}
            className={buttonClasses({ variant: 'danger', className: 'w-full sm:w-auto' })}
          >
            {busy ? 'Suspending…' : 'Suspend business'}
          </button>
        </form>
      )}
    </section>
  );
}

const inputClass =
  'h-11 w-full rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 outline-none focus-visible:outline-2 focus-visible:outline-[color:var(--color-brand)]';
