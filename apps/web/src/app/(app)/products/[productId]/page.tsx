import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Permission } from '@carl/domain';
import { activeBranch, hasPermission } from '@carl/application';
import { EmptyState } from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';
import { ProductForm } from '../product-form';

export const metadata: Metadata = { title: 'Edit product' };
export const dynamic = 'force-dynamic';

interface ProductDetail {
  id: string;
  name: string;
  sku: string;
  description: string | null;
  unit: string;
  allow_fractional: boolean;
  is_stock_tracked: boolean;
  is_active: boolean;
  average_cost: number;
  reorder_level: number;
  min_stock: number;
  tax_mode: 'INCLUSIVE' | 'EXCLUSIVE' | 'EXEMPT';
  tax_rate: number | null;
  category_id: string | null;
  image_url: string | null;
  product_prices: { amount: number; tier: string; effective_to: string | null }[];
  product_barcodes: { barcode: string; is_primary: boolean }[];
}

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ productId: string }>;
}) {
  const auth = await requirePermission(Permission.PRODUCTS_VIEW);
  const { productId } = await params;
  const branch = activeBranch(auth);

  const client = await supabase();
  const [{ data: product }, { data: categories }] = await Promise.all([
    client
      .from('products')
      .select(
        `id, name, sku, description, unit, allow_fractional, is_stock_tracked, is_active,
         average_cost, reorder_level, min_stock, tax_mode, tax_rate, category_id, image_url,
         product_prices(amount, tier, effective_to),
         product_barcodes(barcode, is_primary)`,
      )
      .eq('id', productId)
      .maybeSingle<ProductDetail>(),
    client.from('categories').select('id, name').eq('is_active', true).order('name'),
  ]);

  // RLS returns nothing for a product in another tenant, so a forbidden product and a
  // non-existent one look the same from here. That is intended.
  if (!product) notFound();

  if (!branch) {
    return (
      <EmptyState
        title="No branch selected"
        description="Editing a product happens in the context of a branch."
      />
    );
  }

  if (!hasPermission(auth, Permission.PRODUCTS_UPDATE)) {
    return (
      <EmptyState
        title={product.name}
        description="You can see this product but not change it. Ask an administrator if you need to."
      />
    );
  }

  // Only prices currently in force. A superseded price is history and must not be
  // presented as the current one.
  const live = product.product_prices.filter((price) => price.effective_to === null);
  const retail = live.find((price) => price.tier === 'RETAIL');
  const wholesale = live.find((price) => price.tier === 'WHOLESALE');
  const primaryBarcode =
    product.product_barcodes.find((barcode) => barcode.is_primary) ?? product.product_barcodes[0];

  return (
    <>
      <PageHeader title={product.name} description={product.sku} />
      <div className="max-w-3xl">
        <ProductForm
          branchId={branch.id}
          categories={categories ?? []}
          productId={product.id}
          initial={{
            name: product.name,
            sku: product.sku,
            categoryId: product.category_id,
            description: product.description,
            unit: product.unit,
            allowFractional: product.allow_fractional,
            isStockTracked: product.is_stock_tracked,
            isActive: product.is_active,
            retailPrice: retail?.amount ?? 0,
            ...(wholesale ? { wholesalePrice: wholesale.amount } : {}),
            costPrice: product.average_cost,
            reorderLevel: product.reorder_level,
            minStock: product.min_stock,
            taxMode: product.tax_mode,
            ...(product.tax_rate !== null ? { taxRate: product.tax_rate } : {}),
            ...(primaryBarcode ? { barcode: primaryBarcode.barcode } : {}),
            imageUrl: product.image_url,
          }}
        />
      </div>
    </>
  );
}
