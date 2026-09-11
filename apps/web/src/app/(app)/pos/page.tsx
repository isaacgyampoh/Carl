import type { Metadata } from 'next';
import { Permission } from '@carl/domain';
import { activeBranch } from '@carl/application';
import { EmptyState } from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
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

  // What a customer's receipt says about the business: read once per visit to the till,
  // from Settings, rather than on every sale.
  const client = await supabase();
  const [{ data: business }, { data: branchDetails }] = await Promise.all([
    client
      .from('tenants')
      .select('name, phone, address, tax_registration_no, receipt_footer, currency_code')
      .eq('id', auth.tenant.tenantId)
      .maybeSingle(),
    client.from('branches').select('address, phone').eq('id', branch.id).maybeSingle(),
  ]);

  const address = branchDetails?.address ?? business?.address ?? null;

  return (
    <PosTerminal
      branchId={branch.id}
      branchName={branch.name}
      cashierName={auth.user.fullName}
      canDiscount={auth.tenant.permissions.has(Permission.SALES_DISCOUNT)}
      canSellWholesale={auth.tenant.permissions.has(Permission.SALES_SELL_WHOLESALE)}
      receiptHeader={{
        // The trading name customers know, not the registered legal name.
        businessName: business?.name ?? auth.tenant.tenantName,
        addressLines: address ? [address] : [],
        phone: branchDetails?.phone ?? business?.phone ?? null,
        taxId: business?.tax_registration_no ?? null,
        footer: business?.receipt_footer ?? null,
        currencyCode: `${business?.currency_code ?? 'GHS'} `,
      }}
    />
  );
}
