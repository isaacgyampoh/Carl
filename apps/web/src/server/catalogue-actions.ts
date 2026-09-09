'use server';

import { revalidatePath } from 'next/cache';
import { createLogger } from '@carl/shared';
import {
  categorySchema,
  customerSchema,
  productSchema,
  setProductActiveSchema,
  supplierSchema,
  updateCustomerSchema,
  updateSupplierSchema,
  z,
} from '@carl/validation';

import { requireTenant } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { actionOk, toActionResult, type ActionResult } from './errors';

const log = createLogger({ level: 'info', base: { module: 'catalogue-actions' } });

/**
 * Catalogue, customer and supplier mutations.
 *
 * Each of these is thin on purpose. The database function decides authorization, derives
 * the tenant from the branch, and writes everything in one transaction — so this layer
 * validates the request shape and hands it over.
 *
 * In particular none of them accepts a tenant id. There is nowhere to put one.
 */

const upsertProductSchema = z.object({
  branchId: z.uuid(),
  productId: z.uuid().optional(),
  product: productSchema,
});

export async function saveProduct(
  input: unknown,
): Promise<ActionResult<{ productId: string; created: boolean }>> {
  try {
    const { branchId, productId, product } = upsertProductSchema.parse(input);
    const auth = await requireTenant();

    const client = await supabase();
    const { data, error } = await client.rpc('upsert_product', {
      p_branch_id: branchId,
      p_product_id: productId ?? undefined,
      p_name: product.name,
      p_sku: product.sku,
      p_retail_price: product.retailPrice,
      p_category_id: product.categoryId ?? undefined,
      p_description: product.description ?? undefined,
      p_unit: product.unit,
      p_allow_fractional: product.allowFractional,
      p_is_stock_tracked: product.isStockTracked,
      p_is_active: product.isActive,
      p_wholesale_price: product.wholesalePrice ?? undefined,
      p_cost_price: product.costPrice,
      p_reorder_level: product.reorderLevel,
      p_min_stock: product.minStock,
      p_tax_mode: product.taxMode,
      p_tax_rate: product.taxRate ?? undefined,
      p_barcode: product.barcode ?? undefined,
      p_image_url: product.imageUrl ?? undefined,
    });

    if (error) throw error;
    const row = data?.[0];
    if (!row?.product_id) throw new Error('upsert_product returned no row');

    log.info('product saved', {
      tenantId: auth.tenant.tenantId,
      userId: auth.user.userId,
      productId: row.product_id,
      created: row.was_created ?? false,
    });

    revalidatePath('/products');
    revalidatePath(`/products/${row.product_id}`);
    revalidatePath('/inventory');

    return actionOk({ productId: row.product_id, created: row.was_created ?? false });
  } catch (error) {
    return toActionResult(error);
  }
}

/**
 * Deactivates or reactivates a product.
 *
 * Deliberately not a delete. A product with sales history cannot be removed without
 * destroying that history, and a shop that stops stocking something still needs last
 * year's receipts to make sense.
 */
export async function setProductActive(
  input: unknown,
): Promise<ActionResult<{ productId: string }>> {
  try {
    const { productId, isActive } = setProductActiveSchema.parse(input);
    await requireTenant();

    const client = await supabase();
    // Goes through the table rather than an RPC: RLS on `products` already enforces
    // products.update, and this changes a single flag with no derived values.
    const { data, error } = await client
      .from('products')
      .update({ is_active: isActive })
      .eq('id', productId)
      .select('id')
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      // RLS filtered it. Deliberately indistinguishable from "does not exist".
      return toActionResult(new Error('PRODUCT_NOT_FOUND'));
    }

    revalidatePath('/products');
    revalidatePath(`/products/${productId}`);
    return actionOk({ productId });
  } catch (error) {
    return toActionResult(error);
  }
}

export async function createCategory(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const parsed = categorySchema.parse(input);
    const auth = await requireTenant();

    const client = await supabase();
    const { data, error } = await client
      .from('categories')
      .insert({
        // The tenant comes from the verified session, never from the request.
        tenant_id: auth.tenant.tenantId,
        name: parsed.name,
        description: parsed.description ?? null,
      })
      .select('id')
      .single();

    if (error) throw error;
    revalidatePath('/products');
    return actionOk({ id: data.id });
  } catch (error) {
    return toActionResult(error);
  }
}

// --- Customers ---------------------------------------------------------------------------

export async function createCustomer(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const parsed = customerSchema.parse(input);
    const auth = await requireTenant();

    const client = await supabase();
    const { data, error } = await client
      .from('customers')
      .insert({
        tenant_id: auth.tenant.tenantId,
        name: parsed.name,
        phone: parsed.phone ?? null,
        email: parsed.email ?? null,
        address: parsed.address ?? null,
        notes: parsed.notes ?? null,
        default_tier: parsed.defaultTier,
        credit_limit: parsed.creditLimit,
        created_by: auth.user.userId,
      })
      .select('id')
      .single();

    if (error) throw error;
    revalidatePath('/customers');
    return actionOk({ id: data.id });
  } catch (error) {
    return toActionResult(error);
  }
}

export async function updateCustomer(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const { customerId, patch } = updateCustomerSchema.parse(input);
    await requireTenant();

    const client = await supabase();
    const { data, error } = await client
      .from('customers')
      .update({
        name: patch.name,
        phone: patch.phone ?? null,
        email: patch.email ?? null,
        address: patch.address ?? null,
        notes: patch.notes ?? null,
        default_tier: patch.defaultTier,
        credit_limit: patch.creditLimit,
      })
      .eq('id', customerId)
      .select('id')
      .maybeSingle();

    if (error) throw error;
    if (!data) return toActionResult(new Error('NOT_FOUND'));

    revalidatePath('/customers');
    revalidatePath(`/customers/${customerId}`);
    return actionOk({ id: customerId });
  } catch (error) {
    return toActionResult(error);
  }
}

// --- Suppliers ---------------------------------------------------------------------------

export async function createSupplier(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const parsed = supplierSchema.parse(input);
    const auth = await requireTenant();

    const client = await supabase();
    const { data, error } = await client
      .from('suppliers')
      .insert({
        tenant_id: auth.tenant.tenantId,
        name: parsed.name,
        contact_name: parsed.contactName ?? null,
        phone: parsed.phone ?? null,
        email: parsed.email ?? null,
        address: parsed.address ?? null,
        notes: parsed.notes ?? null,
        payment_terms_days: parsed.paymentTermsDays,
        created_by: auth.user.userId,
      })
      .select('id')
      .single();

    if (error) throw error;
    revalidatePath('/suppliers');
    return actionOk({ id: data.id });
  } catch (error) {
    return toActionResult(error);
  }
}

export async function updateSupplier(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const { supplierId, patch } = updateSupplierSchema.parse(input);
    await requireTenant();

    const client = await supabase();
    const { data, error } = await client
      .from('suppliers')
      .update({
        name: patch.name,
        contact_name: patch.contactName ?? null,
        phone: patch.phone ?? null,
        email: patch.email ?? null,
        address: patch.address ?? null,
        notes: patch.notes ?? null,
        payment_terms_days: patch.paymentTermsDays,
      })
      .eq('id', supplierId)
      .select('id')
      .maybeSingle();

    if (error) throw error;
    if (!data) return toActionResult(new Error('NOT_FOUND'));

    revalidatePath('/suppliers');
    return actionOk({ id: supplierId });
  } catch (error) {
    return toActionResult(error);
  }
}
