import type { Metadata } from 'next';
import { Permission } from '@carl/domain';
import { activeBranch } from '@carl/application';
import { EmptyState } from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';
import { ProductForm } from '../product-form';

export const metadata: Metadata = { title: 'New product' };
export const dynamic = 'force-dynamic';

export default async function NewProductPage() {
  // The route is gated as a courtesy; upsert_product checks the same permission again,
  // which is what actually prevents an unauthorised create.
  const auth = await requirePermission(Permission.PRODUCTS_CREATE);
  const branch = activeBranch(auth);

  if (!branch) {
    return (
      <EmptyState
        title="No branch selected"
        description="A product is created in the context of a branch. Ask an administrator to assign you to one."
      />
    );
  }

  const client = await supabase();
  const { data: categories } = await client
    .from('categories')
    .select('id, name')
    .eq('is_active', true)
    .order('name');

  return (
    <>
      <PageHeader title="New product" />
      <div className="max-w-3xl">
        <ProductForm branchId={branch.id} categories={categories ?? []} />
      </div>
    </>
  );
}
