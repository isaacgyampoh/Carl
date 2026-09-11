import type { Metadata } from 'next';
import { Permission } from '@carl/domain';

import { PageHeader } from '@/components/page-header';
import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { SettingsForm } from './settings-form';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

/** A business's own settings. The platform owner's billing and account terms are elsewhere. */
export default async function SettingsPage() {
  const auth = await requirePermission(Permission.SETTINGS_MANAGE);
  const client = await supabase();
  const { data: tenant } = await client
    .from('tenants')
    .select(
      'name, legal_name, contact_person, email, phone, address, timezone, receipt_footer, tax_registration_no, default_tax_rate, prices_include_tax',
    )
    .eq('id', auth.tenant.tenantId)
    .maybeSingle();

  return (
    <>
      <PageHeader
        title="Settings"
        description="Your business details, receipts, tax and local time."
      />
      <SettingsForm
        initial={{
          name: tenant?.name ?? auth.tenant.tenantName,
          legalName: tenant?.legal_name ?? '',
          contactPerson: tenant?.contact_person ?? '',
          email: tenant?.email ?? '',
          phone: tenant?.phone ?? '',
          address: tenant?.address ?? '',
          timezone: tenant?.timezone ?? 'Africa/Accra',
          receiptFooter: tenant?.receipt_footer ?? '',
          taxRegistrationNo: tenant?.tax_registration_no ?? '',
          defaultTaxRate: Number(tenant?.default_tax_rate ?? 0),
          pricesIncludeTax: tenant?.prices_include_tax ?? true,
        }}
      />
    </>
  );
}
