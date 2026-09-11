import type { Metadata } from 'next';
import Link from 'next/link';
import { Permission } from '@carl/domain';
import { activeBranch, hasPermission } from '@carl/application';
import { formatMoney, formatQuantity } from '@carl/shared';
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Stat,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  buttonClasses,
} from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { ilikeAny, searchTerm } from '@/lib/search';
import { supabase } from '@/lib/supabase';
import { AdjustStockForm } from '@/components/adjust-stock-form';
import { ListSearch } from '@/components/list-search';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { pageParams, toPage } from '@/server/queries';

export const metadata: Metadata = { title: 'Inventory' };
export const dynamic = 'force-dynamic';

interface StockRow {
  quantity: number;
  reserved: number;
  reorder_level: number;
  last_counted_at: string | null;
  products: { id: string; name: string; sku: string; unit: string; average_cost: number } | null;
}

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const auth = await requirePermission(Permission.INVENTORY_VIEW);
  const params = await searchParams;
  const { page, pageSize, from, to } = pageParams(params);
  const search = searchTerm(params.q);
  const branch = activeBranch(auth);
  const canSeeCost = hasPermission(auth, Permission.PRODUCTS_VIEW_COST);
  const lowOnly = params.filter === 'low';
  const canAdjust = hasPermission(auth, Permission.INVENTORY_ADJUST);

  const client = await supabase();

  // Valuation is aggregated in the database. Summing stock value in React would mean
  // pulling every row to display one number.
  const { data: valuation } = await client.rpc('stock_valuation', {
    p_tenant_id: auth.tenant.tenantId,
    p_branch_id: branch?.id,
  });
  const totals = valuation?.[0];

  /*
   * "Low" compares two columns, which PostgREST cannot filter on. This used to fetch one page
   * and then filter it in JavaScript, so a low product on page two never appeared, and the
   * count and page links described the unfiltered list. The low products now come from the
   * database over the whole branch, and the page is fetched from those.
   */
  const lowProductIds = lowOnly
    ? (
        (
          await client.rpc('low_stock_items', {
            p_tenant_id: auth.tenant.tenantId,
            ...(branch ? { p_branch_id: branch.id } : {}),
            p_limit: 100,
          })
        ).data ?? []
      )
        .map((item) => item.product_id)
        .filter((id): id is string => id !== null)
    : null;

  /*
   * Stock rows carry no name of their own; the search is over the products they belong to,
   * resolved to ids first, the same way the low-stock filter below narrows the list.
   */
  const matchingProductIds = search
    ? (
        (
          await client
            .from('products')
            .select('id')
            .eq('tenant_id', auth.tenant.tenantId)
            .or(ilikeAny(['name', 'sku'], search))
            .limit(500)
        ).data ?? []
      ).map((product) => product.id)
    : null;

  let query = client
    .from('inventory')
    .select(
      'quantity, reserved, reorder_level, last_counted_at, products(id, name, sku, unit, average_cost)',
      { count: 'exact' },
    )
    .eq('tenant_id', auth.tenant.tenantId)
    .order('quantity')
    .range(from, to);

  if (branch) query = query.eq('branch_id', branch.id);
  if (lowProductIds) {
    // An empty `in` list is not valid; a nil id matches nothing, which is the right answer.
    query = query.in(
      'product_id',
      lowProductIds.length > 0 ? lowProductIds : ['00000000-0000-0000-0000-000000000000'],
    );
  }
  if (matchingProductIds) {
    query = query.in(
      'product_id',
      matchingProductIds.length > 0 ? matchingProductIds : ['00000000-0000-0000-0000-000000000000'],
    );
  }
  const { data, count } = await query.returns<StockRow[]>();

  const rows = data ?? [];
  const stock = toPage(rows, count, page, pageSize);

  return (
    <>
      <PageHeader
        title="Inventory"
        description={
          branch
            ? `Stock held at ${branch.name}. Every change is recorded in the movement ledger.`
            : 'Stock across the branches you can access.'
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Products in stock"
          value={(totals?.product_count ?? 0).toLocaleString('en-GH')}
        />
        <Stat
          label="Units on hand"
          value={formatQuantity(Math.round((totals?.total_units ?? 0) * 1000))}
        />
        {canSeeCost && <Stat label="Value at cost" value={formatMoney(totals?.cost_value ?? 0)} />}
        <Stat label="Value at retail" value={formatMoney(totals?.retail_value ?? 0)} />
      </div>

      <div className="mb-4">
        <ListSearch
          initialQuery={search ?? ''}
          placeholder="Search by product name or SKU"
          label="Search stock"
        />
      </div>

      <Card className="overflow-hidden">
        <CardHeader
          title={lowOnly ? 'Low stock' : 'Stock on hand'}
          description={
            lowOnly
              ? 'Products at or below their reorder level.'
              : 'Lowest first, so what needs attention is at the top.'
          }
        />
        {stock.rows.length === 0 ? (
          <EmptyState
            title={
              search
                ? `Nothing matches “${search}”`
                : lowOnly
                  ? 'Nothing needs reordering'
                  : 'No stock recorded yet'
            }
            description={
              lowOnly
                ? 'Every product is above its reorder level.'
                : 'Receive a purchase, or open a product and adjust its stock.'
            }
            action={
              !lowOnly && hasPermission(auth, Permission.PRODUCTS_CREATE) ? (
                <Link href="/products/new" className={buttonClasses({ size: 'sm' })}>
                  Add a product
                </Link>
              ) : undefined
            }
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Product</TH>
                  <TH numeric>On hand</TH>
                  <TH numeric from="md">
                    Reserved
                  </TH>
                  <TH numeric from="lg">
                    Reorder at
                  </TH>
                  {canSeeCost && (
                    <TH numeric from="lg">
                      Value
                    </TH>
                  )}
                  <TH from="lg">Last counted</TH>
                  {canAdjust && branch && <TH className="text-right">Adjust</TH>}
                </TR>
              </THead>
              <TBody>
                {stock.rows.map((row) => {
                  const low = row.quantity <= row.reorder_level;
                  const out = row.quantity <= 0;
                  return (
                    <TR key={row.products?.id ?? row.products?.sku}>
                      <TD>
                        <span className="font-medium">{row.products?.name}</span>
                        <span className="block text-xs text-[color:var(--color-ink-muted)]">
                          {row.products?.sku}
                        </span>
                      </TD>
                      <TD numeric>
                        <span
                          className={
                            out
                              ? 'text-[color:var(--color-danger)]'
                              : low
                                ? 'text-[color:var(--color-warning)]'
                                : undefined
                          }
                        >
                          {formatQuantity(Math.round(row.quantity * 1000), {
                            unit: row.products?.unit ?? 'unit',
                          })}
                        </span>
                      </TD>
                      <TD numeric from="md" className="text-[color:var(--color-ink-muted)]">
                        {row.reserved > 0 ? formatQuantity(Math.round(row.reserved * 1000)) : '—'}
                      </TD>
                      <TD numeric from="lg" className="text-[color:var(--color-ink-muted)]">
                        {formatQuantity(Math.round(row.reorder_level * 1000))}
                      </TD>
                      {canSeeCost && (
                        <TD numeric from="lg">
                          {formatMoney(
                            Math.round(row.quantity * (row.products?.average_cost ?? 0)),
                          )}
                        </TD>
                      )}
                      <TD from="lg" className="text-[color:var(--color-ink-muted)]">
                        {row.last_counted_at ? (
                          new Date(row.last_counted_at).toLocaleDateString('en-GH')
                        ) : (
                          <Badge tone="neutral">Never</Badge>
                        )}
                      </TD>
                      {canAdjust && branch && row.products && (
                        <TD className="text-right">
                          <AdjustStockForm
                            branchId={branch.id}
                            productId={row.products.id}
                            compact
                          />
                        </TD>
                      )}
                    </TR>
                  );
                })}
              </TBody>
            </Table>
            <Pagination
              page={stock.page}
              pageCount={stock.pageCount}
              total={stock.total}
              basePath="/inventory"
              searchParams={params}
            />
          </>
        )}
      </Card>
    </>
  );
}
