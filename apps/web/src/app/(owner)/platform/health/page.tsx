import type { Metadata } from 'next';
import { Badge, Card, CardHeader, EmptyState, Stat } from '@carl/ui';

import { PageHeader } from '@/components/page-header';
import { requirePlatformAdmin } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

export const metadata: Metadata = { title: 'Health · Carl platform' };
export const dynamic = 'force-dynamic';

interface ErrorRow {
  id: string;
  occurred_at: string;
  message: string;
  route: string | null;
  method: string | null;
  surface: string | null;
  digest: string | null;
}

/**
 * What has gone wrong lately.
 *
 * Carl used to fail silently in production: the shop saw a broken screen and the owner found
 * out when somebody phoned. Every unhandled server error is recorded now, and this is where
 * they are read — messages included, because the owner is the person who can act on them.
 *
 * Stacks and request payloads are never stored, so there is nothing here that could put a
 * customer's data on a screen.
 */
export default async function HealthPage() {
  await requirePlatformAdmin();
  const client = await supabase();

  const since = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const [recent, day, week] = await Promise.all([
    client
      .from('app_errors')
      .select('id, occurred_at, message, route, method, surface, digest')
      .order('occurred_at', { ascending: false })
      .limit(50)
      .returns<ErrorRow[]>(),
    client
      .from('app_errors')
      .select('id', { count: 'exact', head: true })
      .gte('occurred_at', since(24)),
    client
      .from('app_errors')
      .select('id', { count: 'exact', head: true })
      .gte('occurred_at', since(24 * 7)),
  ]);

  const rows = recent.data ?? [];
  const when = (iso: string) =>
    new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Health"
        description="Server errors from production. A scheduled check reads the same records every fifteen minutes and raises an alert."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="p-5">
          <Stat label="Errors, last 24 hours" value={String(day.count ?? 0)} />
        </Card>
        <Card className="p-5">
          <Stat label="Errors, last 7 days" value={String(week.count ?? 0)} />
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Most recent"
          description="Newest first. Records older than thirty days are pruned."
        />
        {rows.length === 0 ? (
          <EmptyState
            title="Nothing has failed"
            description="No server error has been recorded. This is what a healthy deployment looks like."
          />
        ) : (
          <ul className="divide-y divide-[color:var(--color-border)]">
            {rows.map((row) => (
              <li key={row.id} className="space-y-1 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{row.route ?? 'unknown route'}</span>
                  {row.method && <Badge tone="neutral">{row.method}</Badge>}
                  {row.surface && <Badge tone="neutral">{row.surface}</Badge>}
                  <span className="text-xs text-[color:var(--color-ink-muted)]">
                    {when(row.occurred_at)}
                  </span>
                </div>
                <p className="break-words text-sm text-[color:var(--color-ink-muted)]">
                  {row.message}
                </p>
                {row.digest && (
                  <p className="text-xs text-[color:var(--color-ink-muted)]">digest {row.digest}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
