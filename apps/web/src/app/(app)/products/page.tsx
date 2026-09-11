import type { Metadata } from 'next';
import Link from 'next/link';
import { Permission } from '@carl/domain';
import { hasPermission } from '@carl/application';
import { formatMoney, formatQuantity } from '@carl/shared';
import { Badge, Card, EmptyState, Table, TBody, TD, TH, THead, TR, buttonClasses } from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { pageParams, toPage } from '@/server/queries';
import { ListSearch } from '@/components/list-search';
import { ilikeAny, searchTerm } from '@/lib/search';

export const metadata: Metadata = { title: 'Products' };
export const dynamic = 'force-dynamic';

interface ProductRow {
  id: string;
  name: string;
  sku: string;
  unit: string;
  is_active: boolean;
  average_cost: number;
  categories: { name: string } | null;
  product_prices: { amount: number; tier: string }[];
  inventory: { quantity: number; reorder_level: number }[];
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const auth = await requirePermission(Permission.PRODUCTS_VIEW);
  const params = await searchParams;
  const { page, pageSize, from, to } = pageParams(params);
  const search = searchTerm(params.q);

  // Cost prices expose the business's margins, so they are gated behind their own
  // permission rather than shown to anyone who can see the catalogue.
  const canSeeCost = hasPermission(auth, Permission.PRODUCTS_VIEW_COST);
  const branchId = auth.tenant.activeBranchId;

  const client = await supabase();
  let query = client
    .from('products')
    .select(
      `id, name, sku, unit, is_active, average_cost,
       categories(name),
       product_prices(amount, tier),
       inventory(quantity, reorder_level)`,
      { count: 'exact' },
    )
    .eq('tenant_id', auth.tenant.tenantId)
    .order('name')
    .range(from, to);

  if (search) {
    // Matches the POS search behaviour: name or SKU, case-insensitive.
    query = query.or(ilikeAny(['name', 'sku'], search));
  }

  if (branchId) {
    // Stock is counted per branch. Unfiltered, the embed returns a row for every branch and
    // the column showed whichever came back first.
    query = query.eq('inventory.branch_id', branchId);
  }

  const { data, count } = await query.returns<ProductRow[]>();
  const products = toPage(data, count, page, pageSize);

  return (
    <>
      <PageHeader
        title="Products"
        description="The catalogue is shared across every branch; stock is counted per branch."
        action={
          hasPermission(auth, Permission.PRODUCTS_CREATE) ? (
            <Link href="/products/new" className={buttonClasses()}>
              Add product
            </Link>
          ) : null
        }
      />

      <ListSearch
        initialQuery={search ?? ''}
        placeholder="Search by name or SKU"
        label="Search products"
      />

      <Card className="mt-4 overflow-hidden">
        {products.rows.length === 0 ? (
          <EmptyState
            title={search ? `Nothing matches “${search}”` : 'No products yet'}
            description={
              search
                ? 'Try a different name or SKU.'
                : 'Add your first product to start selling. You can import a catalogue later.'
            }
            action={
              !search && hasPermission(auth, Permission.PRODUCTS_CREATE) ? (
                <Link href="/products/new" className={buttonClasses()}>
                  Add product
                </Link>
              ) : null
            }
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Product</TH>
                  <TH>Category</TH>
                  <TH numeric>Retail</TH>
                  {canSeeCost && <TH numeric>Cost</TH>}
                  <TH numeric>In stock</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {products.rows.map((product) => {
                  const retail = product.product_prices.find((p) => p.tier === 'RETAIL');
                  const stock = product.inventory[0];
                  const low = stock ? stock.quantity <= stock.reorder_level : false;

                  return (
                    <TR key={product.id}>
                      <TD>
                        <Link
                          href={`/products/${product.id}`}
                          className="font-medium hover:text-[color:var(--color-brand)]"
                        >
                          {product.name}
                        </Link>
                        <span className="block text-xs text-[color:var(--color-ink-muted)]">
                          {product.sku}
                        </span>
                      </TD>
                      <TD className="text-[color:var(--color-ink-muted)]">
                        {product.categories?.name ?? '—'}
                      </TD>
                      <TD numeric>{retail ? formatMoney(retail.amount) : '—'}</TD>
                      {canSeeCost && <TD numeric>{formatMoney(product.average_cost)}</TD>}
                      <TD numeric>
                        {branchId && stock ? (
                          <span className={low ? 'text-[color:var(--color-warning)]' : undefined}>
                            {formatQuantity(Math.round(stock.quantity * 1000), {
                              unit: product.unit,
                            })}
                          </span>
                        ) : (
                          '—'
                        )}
                      </TD>
                      <TD>
                        {product.is_active ? (
                          <Badge tone="positive">Active</Badge>
                        ) : (
                          <Badge tone="neutral">Inactive</Badge>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
            <Pagination
              page={products.page}
              pageCount={products.pageCount}
              total={products.total}
              basePath="/products"
              searchParams={params}
            />
          </>
        )}
      </Card>
    </>
  );
}
