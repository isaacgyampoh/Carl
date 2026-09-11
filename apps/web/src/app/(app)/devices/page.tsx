import type { Metadata } from 'next';
import { Permission } from '@carl/domain';
import { hasPermission } from '@carl/application';
import Link from 'next/link';
import {
  Badge,
  Card,
  EmptyState,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  buttonClasses,
  statusTone,
} from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';
import { DeviceActions } from './device-actions';

export const metadata: Metadata = { title: 'Terminals' };
export const dynamic = 'force-dynamic';

interface DeviceRow {
  id: string;
  code: string;
  name: string;
  status: string;
  platform: string | null;
  app_version: string | null;
  last_seen_at: string | null;
  last_sync_at: string | null;
  pending_sync_count: number;
  authorized_until: string | null;
  health: string;
}

/**
 * POS terminals.
 *
 * Reads `devices_safe`, which omits the credential hash entirely — so a careless change to
 * this page cannot put a device secret's hash into a server-rendered payload.
 */
export default async function DevicesPage() {
  const auth = await requirePermission(Permission.DEVICES_VIEW);
  const canManage = hasPermission(auth, Permission.DEVICES_MANAGE);

  const client = await supabase();
  const { data } = await client
    .from('devices_safe')
    .select(
      'id, code, name, status, platform, app_version, last_seen_at, last_sync_at, pending_sync_count, authorized_until, health',
    )
    .eq('tenant_id', auth.tenant.tenantId)
    .order('code')
    .returns<DeviceRow[]>();

  const devices = data ?? [];

  return (
    <>
      <PageHeader
        title="Terminals"
        description="Each till has its own identity, so a stolen machine can be stopped without touching anyone's account."
      />

      <Card className="overflow-hidden">
        {devices.length === 0 ? (
          <EmptyState
            title="No terminals registered"
            action={
              canManage ? (
                <Link href="/windows-pos" className={buttonClasses({ size: 'sm' })}>
                  Set up a Windows till
                </Link>
              ) : undefined
            }
            description="A terminal is created here, then activated on the machine with a one-time code."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Terminal</TH>
                <TH>Health</TH>
                <TH from="sm">Last sync</TH>
                <TH numeric from="md">
                  Queued
                </TH>
                <TH from="md">Offline until</TH>
                {canManage && <TH>Actions</TH>}
              </TR>
            </THead>
            <TBody>
              {devices.map((device) => (
                <TR key={device.id}>
                  <TD>
                    <span className="font-medium">{device.name}</span>
                    <span className="block font-mono text-xs text-[color:var(--color-ink-muted)]">
                      {device.code}
                      {device.app_version && ` · v${device.app_version}`}
                    </span>
                  </TD>
                  <TD>
                    <Badge tone={statusTone(device.health)}>{device.health.toLowerCase()}</Badge>
                  </TD>
                  <TD from="sm" className="text-[color:var(--color-ink-muted)]">
                    {device.last_sync_at
                      ? new Date(device.last_sync_at).toLocaleString('en-GH', {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })
                      : 'Never'}
                  </TD>
                  <TD from="md" numeric>
                    {device.pending_sync_count > 0 ? (
                      <span className="text-[color:var(--color-warning)]">
                        {device.pending_sync_count}
                      </span>
                    ) : (
                      '—'
                    )}
                  </TD>
                  <TD from="md" className="text-[color:var(--color-ink-muted)]">
                    {/* How long this till may keep selling without reaching the server. */}
                    {device.authorized_until
                      ? new Date(device.authorized_until).toLocaleDateString('en-GH')
                      : '—'}
                  </TD>
                  {canManage && (
                    <TD>
                      <DeviceActions
                        deviceId={device.id}
                        deviceName={device.name}
                        status={device.status}
                      />
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
