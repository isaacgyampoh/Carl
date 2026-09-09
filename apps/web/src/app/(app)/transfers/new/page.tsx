import type { Metadata } from 'next';
import { Permission } from '@carl/domain';
import { activeBranch } from '@carl/application';
import { EmptyState } from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';
import { TransferForm } from './transfer-form';

export const metadata: Metadata = { title: 'New transfer' };
export const dynamic = 'force-dynamic';

export default async function NewTransferPage() {
  const auth = await requirePermission(Permission.INVENTORY_TRANSFER_CREATE);
  const branch = activeBranch(auth);

  if (!branch) {
    return (
      <EmptyState
        title="No branch selected"
        description="A transfer moves stock out of a branch you are assigned to."
      />
    );
  }

  if (auth.tenant.branches.length < 2) {
    return (
      <EmptyState
        title="Only one branch"
        description="Transfers move stock between branches. Add a second branch first."
      />
    );
  }

  const client = await supabase();
  const { data: stock } = await client
    .from('inventory')
    .select('quantity, products(id, name, sku, unit, average_cost)')
    .eq('branch_id', branch.id)
    .gt('quantity', 0)
    .returns<
      {
        quantity: number;
        products: {
          id: string;
          name: string;
          sku: string;
          unit: string;
          average_cost: number;
        } | null;
      }[]
    >();

  return (
    <>
      <PageHeader title="New transfer" />
      <div className="max-w-4xl">
        <TransferForm
          // Every branch in the tenant may receive; only branches this user can act in may
          // send. The database enforces the same distinction.
          branches={auth.tenant.branches.map((b) => ({ id: b.id, name: b.name }))}
          sourceBranches={auth.tenant.branches.map((b) => ({ id: b.id, name: b.name }))}
          defaultSourceId={branch.id}
          // flatMap rather than filter-then-assert: the empty array narrows the type
          // without claiming a value is present that the type system cannot see.
          products={(stock ?? []).flatMap((row) =>
            row.products
              ? [
                  {
                    id: row.products.id,
                    name: row.products.name,
                    sku: row.products.sku,
                    unit: row.products.unit,
                    averageCost: row.products.average_cost,
                    available: row.quantity,
                  },
                ]
              : [],
          )}
        />
      </div>
    </>
  );
}
