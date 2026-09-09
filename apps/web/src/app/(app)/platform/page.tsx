import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Card,
  CardHeader,
  EmptyState,
  Stat,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Badge,
  statusTone,
  buttonClasses,
} from '@carl/ui';

import { requirePlatformAdmin } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';

export const metadata: Metadata = { title: 'Carl platform' };
export const dynamic = 'force-dynamic';

/**
 * Platform administration.
 *
 * Note what is *not* here: any customer's sales, stock or takings. Being a platform
 * administrator grants the platform — tenants, devices, subscriptions, support records —
 * and nothing about a business's own data. Reading that requires an explicit, time-boxed
 * support grant that the customer can see.
 */
export default async function PlatformPage() {
  await requirePlatformAdmin();
  const client = await supabase();

  const [tenants, devices, installations, maintenance] = await Promise.all([
    client
      .from('tenants')
      .select('id, name, slug, status, created_at')
      .order('created_at', { ascending: false }),
    client.from('devices_safe').select('id, status, health'),
    client
      .from('installations')
      .select('id, reference, status, scheduled_for, tenants(name)')
      .order('created_at', { ascending: false })
      .limit(5),
    client
      .from('maintenance_records')
      .select('id, reference, issue, status, priority, reported_at, tenants(name)')
      .neq('status', 'CLOSED')
      .order('reported_at', { ascending: false })
      .limit(5),
  ]);

  const allTenants = tenants.data ?? [];
  const allDevices = devices.data ?? [];

  const byStatus = (status: string) => allTenants.filter((t) => t.status === status).length;

  return (
    <>
      <PageHeader
        title="Carl platform"
        description="The businesses running on Carl. This area does not show any customer's trading data."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Businesses" value={allTenants.length.toLocaleString('en-GH')} />
        <Stat label="Active" value={byStatus('ACTIVE').toLocaleString('en-GH')} tone="positive" />
        <Stat
          label="Suspended"
          value={(byStatus('SUSPENDED') + byStatus('GRACE_PERIOD')).toLocaleString('en-GH')}
          tone={byStatus('SUSPENDED') > 0 ? 'danger' : 'neutral'}
        />
        <Stat
          label="Terminals online"
          value={`${allDevices.filter((d) => d.health === 'ONLINE').length} / ${allDevices.length}`}
        />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader
            title="Businesses"
            action={
              <Link
                href="/platform/tenants"
                className={buttonClasses({ variant: 'ghost', size: 'sm' })}
              >
                View all
              </Link>
            }
          />
          {allTenants.length === 0 ? (
            <EmptyState
              title="No businesses yet"
              description="Provision the first tenant to begin."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Business</TH>
                  <TH>Status</TH>
                  <TH>Since</TH>
                </TR>
              </THead>
              <TBody>
                {allTenants.slice(0, 8).map((tenant) => (
                  <TR key={tenant.id}>
                    <TD>
                      <span className="font-medium">{tenant.name}</span>
                      <span className="block font-mono text-xs text-[color:var(--color-ink-muted)]">
                        {tenant.slug}
                      </span>
                    </TD>
                    <TD>
                      <Badge tone={statusTone(tenant.status)}>
                        {tenant.status.replace(/_/g, ' ').toLowerCase()}
                      </Badge>
                    </TD>
                    <TD className="text-[color:var(--color-ink-muted)]">
                      {new Date(tenant.created_at).toLocaleDateString('en-GH')}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        <div className="flex flex-col gap-5">
          <Card className="overflow-hidden">
            <CardHeader title="Open maintenance" />
            {(maintenance.data ?? []).length === 0 ? (
              <EmptyState title="Nothing outstanding" />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Issue</TH>
                    <TH>Business</TH>
                    <TH>Priority</TH>
                  </TR>
                </THead>
                <TBody>
                  {(maintenance.data ?? []).map((record) => (
                    <TR key={record.id}>
                      <TD>
                        <span className="font-medium">{record.issue}</span>
                        <span className="block font-mono text-xs text-[color:var(--color-ink-muted)]">
                          {record.reference}
                        </span>
                      </TD>
                      <TD className="text-[color:var(--color-ink-muted)]">
                        {record.tenants?.name ?? '—'}
                      </TD>
                      <TD>
                        <Badge tone={record.priority === 'URGENT' ? 'danger' : 'neutral'}>
                          {record.priority.toLowerCase()}
                        </Badge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Recent installations" />
            {(installations.data ?? []).length === 0 ? (
              <EmptyState title="No installations recorded" />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Reference</TH>
                    <TH>Business</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {(installations.data ?? []).map((record) => (
                    <TR key={record.id}>
                      <TD className="font-mono text-xs">{record.reference}</TD>
                      <TD className="text-[color:var(--color-ink-muted)]">
                        {record.tenants?.name ?? '—'}
                      </TD>
                      <TD>
                        <Badge tone={statusTone(record.status)}>
                          {record.status.replace(/_/g, ' ').toLowerCase()}
                        </Badge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
