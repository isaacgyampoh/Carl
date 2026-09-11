import type { Metadata } from 'next';
import Link from 'next/link';
import { Permission } from '@carl/domain';
import { Badge, Card, CardBody, CardHeader, EmptyState, buttonClasses, statusTone } from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { windowsInstaller } from '@/lib/downloads';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';
import { AddTerminalForm } from './add-terminal-form';

export const metadata: Metadata = { title: 'Windows POS' };
export const dynamic = 'force-dynamic';

interface TillRow {
  id: string;
  code: string;
  name: string;
  status: string;
  last_seen_at: string | null;
  pending_sync_count: number;
}

/**
 * Setting up a Windows till, from download to first sale.
 *
 * Carl POS for Windows is the desktop application: it keeps its own copy of the catalogue and
 * records every sale on disk before the receipt prints, so a till keeps selling through an
 * outage and sends each sale exactly once when the connection returns. It joins this business
 * through a one-time code issued here; nothing on the till decides which business it serves.
 */
export default async function WindowsPosPage() {
  const auth = await requirePermission(Permission.DEVICES_MANAGE);
  const client = await supabase();
  const [installer, { data: tills }] = await Promise.all([
    windowsInstaller(),
    client
      .from('devices_safe')
      .select('id, code, name, status, last_seen_at, pending_sync_count')
      .eq('tenant_id', auth.tenant.tenantId)
      .order('code')
      .returns<TillRow[]>(),
  ]);

  const megabytes = installer.sizeBytes ? `${(installer.sizeBytes / 1024 / 1024).toFixed(0)} MB` : null;

  return (
    <>
      <PageHeader
        title="Windows POS"
        description="Install Carl POS on each Windows till. It keeps selling when the internet drops and sends every sale when it comes back."
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="1. Download the installer" description="Run it on the Windows till or laptop." />
          <CardBody className="space-y-3 text-sm">
            {installer.available && installer.downloadUrl ? (
              <>
                <a href={installer.downloadUrl} className={buttonClasses({ size: 'lg' })} rel="noopener">
                  Download Carl POS for Windows
                </a>
                <p className="text-[color:var(--color-ink-muted)]">
                  {[installer.version, megabytes, 'Windows 10 or 11, 64-bit'].filter(Boolean).join(' · ')}
                </p>
                <p className="text-xs text-[color:var(--color-ink-muted)]">
                  If Windows shows “Windows protected your PC”, choose <strong>More info</strong> then{' '}
                  <strong>Run anyway</strong>. The installer includes everything it needs, so no
                  internet is required while installing.
                  {installer.checksumsUrl && (
                    <>
                      {' '}
                      <a href={installer.checksumsUrl} className="underline underline-offset-4" rel="noopener">
                        Checksums
                      </a>
                    </>
                  )}
                </p>
              </>
            ) : (
              <p className="text-[color:var(--color-ink-muted)]">
                The Windows installer is being prepared and will appear here as soon as it is
                published. You can add your tills now; their codes last 24 hours and a new one can
                be issued at any time.
              </p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="2. Add the till and get its code" description="One code per till. It works once." />
          <CardBody>
            <AddTerminalForm
              branches={auth.tenant.branches.map((branch) => ({ id: branch.id, name: branch.name }))}
              defaultBranchId={auth.tenant.activeBranchId}
              suggestedName={`Till ${(tills?.length ?? 0) + 1}`}
            />
          </CardBody>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader title="3. On the till" />
        <CardBody>
          <ol className="grid list-decimal gap-2 pl-5 text-sm text-[color:var(--color-ink-muted)] sm:grid-cols-2">
            <li>Run the installer, then open <strong className="text-[color:var(--color-ink)]">Carl POS</strong> from the Start menu.</li>
            <li>Type the 12-character code from step 2. The till joins this business and downloads your products.</li>
            <li>Each cashier signs in on the till with their own PIN from Staff.</li>
            <li>Sell. Without internet the till keeps working and sends every sale when the connection returns.</li>
          </ol>
        </CardBody>
      </Card>

      <Card className="mt-5 overflow-hidden">
        <CardHeader
          title="Your tills"
          action={
            <Link href="/devices" className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
              Manage
            </Link>
          }
        />
        {(tills ?? []).length === 0 ? (
          <EmptyState title="No tills yet" description="Add one above, then enter its code on the till." />
        ) : (
          <ul className="divide-y divide-[color:var(--color-border)]">
            {(tills ?? []).map((till) => (
              <li key={till.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{till.name}</span>
                  <span className="block text-xs text-[color:var(--color-ink-muted)]">
                    {till.code}
                    {till.last_seen_at && ` · last seen ${new Date(till.last_seen_at).toLocaleString('en-GH', { dateStyle: 'medium', timeStyle: 'short' })}`}
                    {till.pending_sync_count > 0 && ` · ${till.pending_sync_count} waiting to send`}
                  </span>
                </span>
                <Badge tone={statusTone(till.status)}>
                  {till.status === 'PENDING' ? 'waiting for code' : till.status.toLowerCase()}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
