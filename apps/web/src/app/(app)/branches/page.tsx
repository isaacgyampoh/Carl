import type { Metadata } from 'next';
import { hasPermission } from '@carl/application';
import { Permission } from '@carl/domain';
import { Badge, Card, EmptyState, Table, TBody, TD, TH, THead, TR } from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';
import { AddBranchForm } from './add-branch-form';

export const metadata: Metadata = { title: 'Branches' };
export const dynamic = 'force-dynamic';

interface BranchRow {
  id: string;
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  is_default: boolean;
  is_active: boolean;
  allow_negative_stock: boolean;
}

export default async function BranchesPage() {
  const auth = await requirePermission(Permission.BRANCHES_VIEW);
  const canManage = hasPermission(auth, Permission.BRANCHES_MANAGE);

  const client = await supabase();
  const { data } = await client
    .from('branches')
    .select('id, code, name, address, phone, is_default, is_active, allow_negative_stock')
    // RLS already confines this to businesses the caller belongs to; this confines it to the
    // one they are working in, or a person on two businesses' staff would see both.
    .eq('tenant_id', auth.tenant.tenantId)
    .order('code')
    .returns<BranchRow[]>();

  const branches = data ?? [];

  return (
    <>
      <PageHeader
        title="Branches"
        description="Products are shared across the business; stock, sales and cash are counted per branch. Add POS computers to a branch under Terminals."
        action={canManage ? <AddBranchForm /> : undefined}
      />

      <Card className="overflow-hidden">
        {branches.length === 0 ? (
          <EmptyState title="No branches" description="Every business has at least one branch." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Branch</TH>
                <TH>Contact</TH>
                <TH>Settings</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {branches.map((branch) => (
                <TR key={branch.id}>
                  <TD>
                    <span className="font-medium">{branch.name}</span>
                    <span className="block font-mono text-xs text-[color:var(--color-ink-muted)]">
                      {branch.code}
                    </span>
                  </TD>
                  <TD className="text-[color:var(--color-ink-muted)]">
                    {branch.address ?? '—'}
                    {branch.phone && (
                      <span className="block text-xs tabular-nums">{branch.phone}</span>
                    )}
                  </TD>
                  <TD>
                    {branch.allow_negative_stock ? (
                      <Badge tone="warning">Negative stock allowed</Badge>
                    ) : (
                      <span className="text-xs text-[color:var(--color-ink-muted)]">
                        Stock must cover a sale
                      </span>
                    )}
                  </TD>
                  <TD>
                    <div className="flex flex-wrap gap-1.5">
                      {branch.is_default && <Badge tone="brand">Default</Badge>}
                      <Badge tone={branch.is_active ? 'positive' : 'neutral'}>
                        {branch.is_active ? 'Active' : 'Closed'}
                      </Badge>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
