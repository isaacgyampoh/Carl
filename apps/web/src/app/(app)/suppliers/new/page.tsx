import type { Metadata } from 'next';
import { Permission } from '@carl/domain';

import { requirePermission } from '@/lib/auth';
import { PageHeader } from '@/components/page-header';
import { SupplierForm } from '../supplier-form';

export const metadata: Metadata = { title: 'New supplier' };
export const dynamic = 'force-dynamic';

export default async function NewSupplierPage() {
  await requirePermission(Permission.SUPPLIERS_MANAGE);
  return (
    <>
      <PageHeader title="New supplier" />
      <div className="max-w-3xl">
        <SupplierForm />
      </div>
    </>
  );
}
