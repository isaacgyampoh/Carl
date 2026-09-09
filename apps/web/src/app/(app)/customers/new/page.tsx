import type { Metadata } from 'next';
import { Permission } from '@carl/domain';

import { requirePermission } from '@/lib/auth';
import { PageHeader } from '@/components/page-header';
import { CustomerForm } from '../customer-form';

export const metadata: Metadata = { title: 'New customer' };
export const dynamic = 'force-dynamic';

export default async function NewCustomerPage() {
  await requirePermission(Permission.CUSTOMERS_CREATE);
  return (
    <>
      <PageHeader title="New customer" />
      <div className="max-w-3xl">
        <CustomerForm />
      </div>
    </>
  );
}
