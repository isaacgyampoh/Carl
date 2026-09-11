import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Permission } from '@carl/domain';
import { activeBranch, hasPermission } from '@carl/application';
import { EmptyState, Card, Alert } from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { signedProductImageUrls } from '@/lib/product-images';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';
import { ProductForm } from '../product-form';
import { formatQuantity } from '@carl/shared';
import { AdjustStockForm } from '@/components/adjust-stock-form';

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
  image_path: string | null;
  product_prices: { amount: number; tier: string; effective_to: string | null }[];
  product_barcodes: { barcode: string; is_primary: boolean }[];
}

export default async function EditProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ productId: string }>;
  searchParams: Promise<{ image?: string }>;
}) {
  const auth = await requirePermission(Permission.PRODUCTS_VIEW);
  const { productId } = await params;
  const branch = activeBranch(auth);

  const client = await supabase();
  const [{ data: product }, { data: categories }, { data: stock }] = await Promise.all([
    client
      .from('products')
      .select(
        `id, name, sku, description, unit, allow_fractional, is_stock_tracked, is_active,
         average_cost, reorder_level, min_stock, tax_mode, tax_rate, category_id, image_path,
         product_prices(amount, tier, effective_to),
         product_barcodes(barcode, is_primary)`,
      )
      .eq('tenant_id', auth.tenant.tenantId)
      .eq('id', productId)
      .maybeSingle<ProductDetail>(),
    client
      .from('categories')
      .select('id, name')
      .eq('tenant_id', auth.tenant.tenantId)
      .eq('is_active', true)
      .order('name'),
    // This branch's stock. A new product has no row until something is recorded.
    branch
      ? client
          .from('inventory')
          .select('quantity')
          .eq('product_id', productId)
          .eq('branch_id', branch.id)
          .maybeSingle<{ quantity: number }>()
      : Promise.resolve({ data: null }),
  ]);

  // RLS returns nothing for a product in another tenant, so a forbidden product and a
  // non-existent one look the same from here. That is intended.
  if (!product) notFound();

  const imageUrls = await signedProductImageUrls(client, [product.image_path]);
  const imageUrl = product.image_path ? imageUrls.get(product.image_path) : undefined;
  const imageFailed = (await searchParams).image === 'failed';

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
      {imageFailed && (
        <Alert tone="warning" className="mb-5 max-w-3xl">
          The product was saved, but its image could not be saved. Choose the image again below.
        </Alert>
      )}
      {product.is_stock_tracked && (
        <Card className="mb-5 max-w-3xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm text-[color:var(--color-ink-muted)]">Stock at {branch.name}</p>
              <p className="text-2xl font-semibold tabular-nums">
                {formatQuantity(Math.round(Number(stock?.quantity ?? 0) * 1000), {
                  unit: product.unit,
                })}
              </p>
            </div>
            {hasPermission(auth, Permission.INVENTORY_ADJUST) && (
              <AdjustStockForm branchId={branch.id} productId={product.id} />
            )}
          </div>
        </Card>
      )}
      <div className="max-w-3xl">
        <ProductForm
          branchId={branch.id}
          categories={categories ?? []}
          productId={product.id}
          image={imageUrl ? { url: imageUrl } : null}
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
          }}
        />
      </div>
    </>
  );
}
