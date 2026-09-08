import type { Metadata } from 'next';
import { Permission } from '@carl/domain';
import { activeBranch } from '@carl/application';
import { EmptyState } from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { PosTerminal } from './pos-terminal';

export const metadata: Metadata = { title: 'Point of sale' };

// A till must never render a cached basket or a stale price.
export const dynamic = 'force-dynamic';

export default async function PosPage() {
  const auth = await requirePermission(Permission.SALES_CREATE);
  const branch = activeBranch(auth);

  if (!branch) {
    return (
      <EmptyState
        title="No branch selected"
        description="You are not assigned to a branch that can take sales. Ask an administrator to assign you to one."
      />
    );
  }

  return (
    <PosTerminal
      branchId={branch.id}
      branchName={branch.name}
      cashierName={auth.user.fullName}
      canDiscount={auth.tenant.permissions.has(Permission.SALES_DISCOUNT)}
      canSellWholesale={auth.tenant.permissions.has(Permission.SALES_SELL_WHOLESALE)}
    />
  );
}
