import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, EmptyState, Stat, buttonClasses, statusTone } from '@carl/ui';

import { PageHeader } from '@/components/page-header';
import { listDevices, type DeviceStatus } from '@/server/platform-queries';

export const metadata: Metadata = { title: 'Terminals · Carl platform' };
export const dynamic = 'force-dynamic';

const STATUSES: readonly (DeviceStatus | 'ALL')[] = [
  'ALL',
  'ACTIVE',
  'PENDING',
  'SUSPENDED',
  'REVOKED',
];

const when = (iso: string | null) => {
  if (!iso) return 'never';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: '2-digit',
  });
};

/**
 * Every terminal on the estate.
 *
 * Issuing and revoking happen on the client's own page, where the branch context is. This
 * view answers the fleet questions instead: which tills have gone quiet, and which
 * activations were issued but never used.
 *
 * No activation code appears here. They are stored only as peppered hashes, and the
 * plaintext is shown exactly once at issue.
 */
export default async function DevicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await searchParams;
  const status = STATUSES.find((s) => s === params.status) ?? 'ALL';
  const devices = await listDevices(status);

  const stale = devices.filter(
    (d) =>
      d.status === 'ACTIVE' &&
      d.lastSeenAt &&
      Date.now() - new Date(d.lastSeenAt).getTime() > 7 * 86_400_000,
  );
  const awaiting = devices.filter((d) => d.pendingActivation);

  return (
    <div className="space-y-4">
      <PageHeader title="Terminals" description={`${devices.length} registered`} />

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Active"
          value={devices.filter((d) => d.status === 'ACTIVE').length.toString()}
          tone="positive"
        />
        <Stat
          label="Awaiting activation"
          value={awaiting.length.toString()}
          tone={awaiting.length > 0 ? 'warning' : 'neutral'}
        />
        <Stat
          label="Not seen in a week"
          value={stale.length.toString()}
          tone={stale.length > 0 ? 'warning' : 'neutral'}
        />
        <Stat
          label="Revoked"
          value={devices.filter((d) => d.status === 'REVOKED').length.toString()}
        />
      </section>

      <div className="-mx-4 overflow-x-auto px-4">
        <div className="flex gap-2 pb-1">
          {STATUSES.map((s) => (
            <Link
              key={s}
              href={s === 'ALL' ? '/platform/devices' : `/platform/devices?status=${s}`}
              className={buttonClasses({ variant: s === status ? 'primary' : 'ghost' })}
            >
              {s === 'ALL' ? 'All' : s.toLowerCase()}
            </Link>
          ))}
        </div>
      </div>

      {devices.length === 0 ? (
        <Card>
          <EmptyState
            title="No terminals"
            description="Issue an activation code from a client's page to set one up."
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-[color:var(--color-border)]">
            {devices.map((d) => (
              <li key={d.id}>
                <Link
                  href={`/platform/clients/${d.tenantId}`}
                  className="block min-h-16 px-4 py-3 hover:bg-[color:var(--color-surface-muted)]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{d.name}</div>
                      <div className="truncate text-sm text-[color:var(--color-ink-muted)]">
                        {d.tenantName} · {d.branchName}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Badge tone={statusTone(d.status)}>{d.status}</Badge>
                      {d.pendingActivation && <Badge tone="warning">Code issued</Badge>}
                    </div>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 text-sm text-[color:var(--color-ink-muted)]">
                    <span>last seen {when(d.lastSeenAt)}</span>
                    {d.activatedAt && <span>activated {when(d.activatedAt)}</span>}
                    {d.revokedAt && <span>revoked {when(d.revokedAt)}</span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
