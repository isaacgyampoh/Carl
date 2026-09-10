import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, EmptyState } from '@carl/ui';

import { PageHeader } from '@/components/page-header';
import { listPlatformAudit } from '@/server/platform-queries';

export const metadata: Metadata = { title: 'Activity · Carl platform' };
export const dynamic = 'force-dynamic';

/** Human wording for the actions the platform policy exposes. */
const LABELS: Record<string, string> = {
  CLIENT_ONBOARDED: 'Client onboarded',
  TENANT_PROVISIONED: 'Business provisioned',
  TENANT_SUSPENDED: 'Business suspended',
  TENANT_REACTIVATED: 'Business reactivated',
  SUBSCRIPTION_CREATED: 'Subscription created',
  SUBSCRIPTION_PAYMENT_RECORDED: 'Payment recorded',
  INVOICE_ISSUED: 'Invoice issued',
  INVOICE_CANCELLED: 'Invoice cancelled',
  DEVICE_REGISTERED: 'Terminal registered',
  DEVICE_ACTIVATION_ISSUED: 'Activation code issued',
  DEVICE_ACTIVATED: 'Terminal activated',
  DEVICE_REVOKED: 'Terminal revoked',
};

/**
 * What the platform did, and who did it.
 *
 * Restricted at the database, not here: the RLS policy limits a platform administrator to
 * platform-operated actions. A merchant's own trading history — the sales they voided, the
 * stock they adjusted — is not visible on this page because it is not readable at all
 * without a time-boxed support grant the customer can see.
 *
 * Metadata is rendered selectively. The audit rows carry amounts and references, which are
 * useful, but nothing here renders a whole payload blindly: an audit view that prints
 * arbitrary JSON is one schema change away from displaying something it should not.
 */
export default async function AuditPage() {
  const entries = await listPlatformAudit(150);

  return (
    <div className="space-y-4">
      <PageHeader title="Activity" description="Platform actions on customer accounts." />

      {entries.length === 0 ? (
        <Card>
          <EmptyState
            title="No platform activity yet"
            description="Onboarding a client, recording a payment or activating a terminal will appear here."
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-[color:var(--color-border)]">
            {entries.map((e) => {
              const amount = typeof e.metadata.amount === 'number' ? e.metadata.amount : null;
              const reference =
                typeof e.metadata.reference === 'string' ? e.metadata.reference : null;
              const invoice =
                typeof e.metadata.invoice_number === 'string' ? e.metadata.invoice_number : null;
              const reason = typeof e.metadata.reason === 'string' ? e.metadata.reason : null;

              return (
                <li key={e.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium">
                        {LABELS[e.action] ?? e.action.replace(/_/g, ' ').toLowerCase()}
                      </div>
                      <div className="truncate text-sm text-[color:var(--color-text-muted)]">
                        {e.tenantId ? (
                          <Link
                            href={`/platform/clients/${e.tenantId}`}
                            className="underline-offset-4 hover:underline"
                          >
                            {e.tenantName}
                          </Link>
                        ) : (
                          e.tenantName
                        )}
                        {' · '}
                        {e.actorName}
                      </div>
                    </div>
                    <time
                      dateTime={e.occurredAt}
                      className="shrink-0 text-sm text-[color:var(--color-text-muted)]"
                    >
                      {new Date(e.occurredAt).toLocaleString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </div>
                  {(amount !== null ||
                    reference !== null ||
                    invoice !== null ||
                    reason !== null) && (
                    <div className="mt-1 flex flex-wrap gap-x-3 text-sm text-[color:var(--color-text-muted)]">
                      {amount !== null && (
                        <span className="tabular-nums">{(amount / 100).toFixed(2)}</span>
                      )}
                      {invoice && <span>{invoice}</span>}
                      {reference && <span>ref {reference}</span>}
                      {reason && <span className="truncate">{reason}</span>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
