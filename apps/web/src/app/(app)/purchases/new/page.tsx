import type { Metadata } from 'next';
import { Permission } from '@carl/domain';
import { activeBranch } from '@carl/application';
import { EmptyState } from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';
import { PurchaseForm } from './purchase-form';

export const metadata: Metadata = { title: 'New purchase' };
export const dynamic = 'force-dynamic';

export default async function NewPurchasePage() {
  const auth = await requirePermission(Permission.PURCHASES_CREATE);
  const branch = activeBranch(auth);

  if (!branch) {
    return (
      <EmptyState
        title="No branch selected"
        description="A purchase is received into a branch. Ask an administrator to assign you to one."
      />
    );
  }

  const client = await supabase();
  const [{ data: suppliers }, { data: products }] = await Promise.all([
    client
      .from('suppliers')
      .select('id, name')
      .eq('tenant_id', auth.tenant.tenantId)
      .eq('is_active', true)
      .order('name'),
    client
      .from('products')
      .select('id, name, sku, unit, average_cost')
      .eq('tenant_id', auth.tenant.tenantId)
      .eq('is_active', true)
      .order('name')
      .limit(1000),
  ]);

  return (
    <>
      <PageHeader title="New purchase" />
      <div className="max-w-4xl">
        <PurchaseForm
          branchId={branch.id}
          branchName={branch.name}
          suppliers={suppliers ?? []}
          products={(products ?? []).map((p) => ({
            id: p.id,
            name: p.name,
            sku: p.sku,
            unit: p.unit,
            averageCost: p.average_cost,
          }))}
        />
      </div>
    </>
  );
}
