'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { createLogger } from '@carl/shared';
import { z } from '@carl/validation';
import {
  completeSaleSchema,
  processReturnSchema,
  productSearchSchema,
  voidSaleSchema,
} from '@carl/validation';

import { requireTenant } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { actionOk, toActionResult, type ActionResult } from './errors';

const log = createLogger({ level: 'info', base: { module: 'pos-actions' } });

export interface SearchResult {
  productId: string;
  name: string;
  sku: string;
  unit: string;
  unitPrice: number;
  quantity: number;
  isExact: boolean;
  packSize: number;
}

/**
 * Looks up products for the till.
 *
 * Runs as the signed-in user, so RLS confines the results to their tenant and branch.
 * There is no tenant filter in this code, and that is intentional: adding one would imply
 * the filter is what provides the isolation.
 */
export async function searchProducts(input: unknown): Promise<ActionResult<SearchResult[]>> {
  try {
    const { branchId, query, tier, limit } = productSearchSchema.parse(input);
    await requireTenant();

    const client = await supabase();
    const { data, error } = await client.rpc('search_products', {
      p_branch_id: branchId,
      p_query: query,
      p_tier: tier,
      p_limit: limit,
    });

    if (error) throw error;

    return actionOk(
      (data ?? []).map((row) => ({
        productId: row.product_id ?? '',
        name: row.name ?? '',
        sku: row.sku ?? '',
        unit: row.unit ?? 'unit',
        unitPrice: row.unit_price ?? 0,
        quantity: row.quantity ?? 0,
        isExact: row.is_exact ?? false,
        packSize: row.pack_size ?? 1,
      })),
    );
  } catch (error) {
    return toActionResult(error);
  }
}

/** A product as the till holds it on the device, so it can sell with no connection. */
export interface CatalogueRow extends SearchResult {
  barcodes: string[];
}

const catalogueSchema = z.object({
  branchId: z.uuid(),
  tier: z.enum(['RETAIL', 'WHOLESALE']).default('RETAIL'),
});

interface ProductRow {
  id: string;
  name: string;
  sku: string;
  unit: string;
  product_prices: { tier: string; amount: number; branch_id: string | null }[] | null;
  product_barcodes: { barcode: string; pack_size: number; is_primary: boolean }[] | null;
  inventory: { branch_id: string; quantity: number }[] | null;
}

/**
 * The whole sellable catalogue for one branch, in one request.
 *
 * The till takes a copy when it has a connection so it can keep selling when it does not. It is
 * the same data the search returns, read the same way — as the signed-in user, so RLS decides
 * what is in it — and it is a convenience, never an authority: prices and stock are resolved
 * again by `complete_sale` when the sale reaches the server.
 *
 * Bounded at two thousand products. A shop larger than that needs a till with a real database,
 * which is the Windows one.
 */
export async function catalogueSnapshot(input: unknown): Promise<ActionResult<CatalogueRow[]>> {
  try {
    const { branchId, tier } = catalogueSchema.parse(input);
    await requireTenant();

    const client = await supabase();
    const { data, error } = await client
      .from('products')
      .select(
        'id, name, sku, unit, product_prices(tier, amount, branch_id), product_barcodes(barcode, pack_size, is_primary), inventory(branch_id, quantity)',
      )
      .eq('is_active', true)
      .order('name')
      .limit(2000)
      .returns<ProductRow[]>();
    if (error) throw error;

    const rows = (data ?? []).map((product) => {
      const prices = (product.product_prices ?? []).filter((price) => price.tier === tier);
      // A price set for this branch wins over the business-wide one, as it does in the database.
      const price = prices.find((row) => row.branch_id === branchId) ?? prices[0];
      const barcodes = product.product_barcodes ?? [];
      const primary = barcodes.find((code) => code.is_primary) ?? barcodes[0];
      const stock = (product.inventory ?? []).find((row) => row.branch_id === branchId);
      return {
        productId: product.id,
        name: product.name,
        sku: product.sku,
        unit: product.unit,
        unitPrice: price?.amount ?? 0,
        quantity: stock?.quantity ?? 0,
        isExact: false,
        packSize: primary?.pack_size ?? 1,
        barcodes: barcodes.map((code) => code.barcode),
      };
    });

    // A product with no price cannot be sold, and showing it offline only creates a refusal
    // later, when the customer is already holding it.
    return actionOk(rows.filter((row) => row.unitPrice > 0));
  } catch (error) {
    return toActionResult(error);
  }
}

export interface CompletedSale {
  saleId: string;
  saleNumber: string;
  total: number;
  amountPaid: number;
  changeGiven: number;
  wasReplayed: boolean;
}

/**
 * Completes a sale.
 *
 * Everything of consequence happens inside `complete_sale()`: prices are resolved, stock
 * is checked and moved, payments are validated, the receipt number is allocated, and the
 * audit entry is written — all in one transaction. This function's whole job is to
 * validate the request shape and hand it over.
 *
 * In particular it does not compute a total. The value the till displayed is not sent and
 * would not be used.
 */
export async function completeSale(input: unknown): Promise<ActionResult<CompletedSale>> {
  const requestId = (await headers()).get('x-request-id') ?? undefined;

  try {
    const parsed = completeSaleSchema.parse(input);
    const auth = await requireTenant();

    const client = await supabase();
    const { data, error } = await client.rpc('complete_sale', {
      p_branch_id: parsed.branchId,
      p_items: parsed.items,
      p_payments: parsed.payments,
      p_idempotency_key: parsed.idempotencyKey,
      p_customer_id: parsed.customerId,
      p_tier: parsed.tier,
      p_device_id: parsed.deviceId,
      p_order_discount_type: parsed.orderDiscount?.type ?? 'NONE',
      p_order_discount_value: parsed.orderDiscount?.value,
      p_discount_reason: parsed.discountReason,
      p_note: parsed.note,
      p_sold_at: parsed.soldAt,
    });

    if (error) throw error;

    const row = data?.[0];
    if (!row) {
      throw new Error('complete_sale returned no row');
    }

    log.info('sale completed', {
      tenantId: auth.tenant.tenantId,
      branchId: parsed.branchId,
      userId: auth.user.userId,
      saleId: row.sale_id ?? undefined,
      replayed: row.was_replayed ?? false,
      ...(requestId ? { requestId } : {}),
    });

    // The dashboard and sales list are both stale the moment a sale lands.
    revalidatePath('/');
    revalidatePath('/sales');

    return actionOk({
      saleId: row.sale_id ?? '',
      saleNumber: row.sale_number ?? '',
      total: row.total ?? 0,
      amountPaid: row.amount_paid ?? 0,
      changeGiven: row.change_given ?? 0,
      wasReplayed: row.was_replayed ?? false,
    });
  } catch (error) {
    // Logged with the full error server-side; the client gets a code and a safe message.
    log.error('sale failed', { error, ...(requestId ? { requestId } : {}) });
    return toActionResult(error);
  }
}

export async function processReturn(
  input: unknown,
): Promise<
  ActionResult<{ returnId: string; returnNumber: string; total: number; wasReplayed: boolean }>
> {
  try {
    const parsed = processReturnSchema.parse(input);
    await requireTenant();

    const client = await supabase();
    const { data, error } = await client.rpc('process_return', {
      p_sale_id: parsed.saleId,
      p_items: parsed.items,
      p_reason: parsed.reason,
      p_idempotency_key: parsed.idempotencyKey,
      p_refund_method: parsed.refundMethod,
      p_refund_reference: parsed.refundReference,
      p_restocked: parsed.restocked,
      p_notes: parsed.notes,
    });

    if (error) throw error;
    const row = data?.[0];
    if (!row) throw new Error('process_return returned no row');

    revalidatePath('/sales');
    revalidatePath(`/sales/${parsed.saleId}`);

    return actionOk({
      returnId: row.return_id ?? '',
      returnNumber: row.return_number ?? '',
      total: row.total ?? 0,
      wasReplayed: row.was_replayed ?? false,
    });
  } catch (error) {
    return toActionResult(error);
  }
}

export async function voidSale(input: unknown): Promise<ActionResult<{ saleId: string }>> {
  try {
    const parsed = voidSaleSchema.parse(input);
    await requireTenant();

    const client = await supabase();
    const { error } = await client.rpc('void_sale', {
      p_sale_id: parsed.saleId,
      p_reason: parsed.reason,
    });

    if (error) throw error;

    revalidatePath('/');
    revalidatePath('/sales');
    revalidatePath(`/sales/${parsed.saleId}`);

    return actionOk({ saleId: parsed.saleId });
  } catch (error) {
    return toActionResult(error);
  }
}
