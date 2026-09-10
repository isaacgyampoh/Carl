import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, EmptyState, Stat, statusTone } from '@carl/ui';

import { PageHeader } from '@/components/page-header';
import { listBranches } from '@/server/platform-queries';

export const metadata: Metadata = { title: 'Branches · Carl platform' };
export const dynamic = 'force-dynamic';

/**
 * Every branch on the platform.
 *
 * Creating and closing a branch stays a merchant operation — it is their business, their
 * staffing and their stock, and doing it on their behalf from here would be acting inside
 * a customer's business rather than operating the platform. This view answers the platform
 * question instead: how many branches exist, which have no terminal, and who they belong to.
 */
export default async function BranchesPage() {
  const branches = await listBranches();
  const withoutTerminal = branches.filter((b) => b.isActive && b.deviceCount === 0);

  return (
    <div className="space-y-4">
      <PageHeader title="Branches" description={`${branches.length} across all clients`} />

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Branches" value={branches.length.toString()} />
        <Stat
          label="Active"
          value={branches.filter((b) => b.isActive).length.toString()}
          tone="positive"
        />
        <Stat
          label="No terminal yet"
          value={withoutTerminal.length.toString()}
          {...(withoutTerminal.length > 0 ? { hint: 'cannot sell offline' } : {})}
          tone={withoutTerminal.length > 0 ? 'warning' : 'neutral'}
        />
      </section>

      {branches.length === 0 ? (
        <Card>
          <EmptyState title="No branches" description="Onboarding a client creates their first." />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-[color:var(--color-border)]">
            {branches.map((b) => (
              <li key={b.id}>
                <Link
                  href={`/platform/clients/${b.tenantId}`}
                  className="block min-h-16 px-4 py-3 hover:bg-[color:var(--color-surface-muted)]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{b.name}</div>
                      <div className="truncate text-sm text-[color:var(--color-text-muted)]">
                        {b.tenantName} · {b.code}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Badge tone={statusTone(b.tenantStatus)}>
                        {b.tenantStatus.replace('_', ' ')}
                      </Badge>
                      {!b.isActive && <Badge tone="neutral">Closed</Badge>}
                    </div>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 text-sm text-[color:var(--color-text-muted)]">
                    <span>
                      {b.deviceCount} {b.deviceCount === 1 ? 'terminal' : 'terminals'}
                    </span>
                    <span>
                      {b.staffCount} {b.staffCount === 1 ? 'person' : 'people'}
                    </span>
                    {b.isActive && b.deviceCount === 0 && (
                      <span className="font-medium text-[color:var(--color-warning)]">
                        No terminal
                      </span>
                    )}
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
