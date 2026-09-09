'use server';

import { revalidatePath } from 'next/cache';
import { createLogger } from '@carl/shared';
import {
  cancelTransferSchema,
  createPurchaseSchema,
  createTransferSchema,
  receivePurchaseSchema,
  receiveTransferSchema,
  transferActionSchema,
} from '@carl/validation';

import { requireTenant } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { actionOk, toActionResult, type ActionResult } from './errors';

const log = createLogger({ level: 'info', base: { module: 'purchasing-actions' } });

/**
 * Purchasing and stock transfers.
 *
 * Every one of these delegates to a database function, and that is the point: receiving a
 * purchase writes to `purchases`, `purchase_items`, `products`, `inventory` and
 * `inventory_movements`, and either all of it happens or none of it does. Orchestrating
 * that from here with separate calls would leave windows where stock has moved but the
 * purchase does not say so.
 *
 * None of them accepts a tenant id, and the transfer functions check authority over the
 * *source* branch specifically — moving stock out of a branch is the operation that needs
 * permission, and checking only the tenant would let a manager at one site empty another.
 */

export async function createPurchase(
  input: unknown,
): Promise<ActionResult<{ purchaseId: string; reference: string }>> {
  try {
    const parsed = createPurchaseSchema.parse(input);
    const auth = await requireTenant();

    const client = await supabase();
    const { data, error } = await client.rpc('create_purchase', {
      p_branch_id: parsed.branchId,
      p_items: parsed.items.map((item) => ({
        product_id: item.productId,
        quantity: item.quantity,
        unit_cost: item.unitCost,
      })),
      p_supplier_id: parsed.supplierId ?? undefined,
      p_supplier_invoice_no: parsed.supplierInvoiceNo,
      p_notes: parsed.notes,
      p_expected_at: parsed.expectedAt,
    });

    if (error) throw error;
    const row = data?.[0];
    if (!row?.purchase_id) throw new Error('create_purchase returned no row');

    log.info('purchase created', {
      tenantId: auth.tenant.tenantId,
      branchId: parsed.branchId,
      purchaseId: row.purchase_id,
      lines: parsed.items.length,
    });

    revalidatePath('/purchases');
    return actionOk({ purchaseId: row.purchase_id, reference: row.reference ?? '' });
  } catch (error) {
    return toActionResult(error);
  }
}

/**
 * Receives a delivery.
 *
 * This is the operation that moves stock and updates weighted-average cost. It is atomic
 * in the database: if the inventory update fails, the purchase status, the received
 * quantities and the ledger movements all roll back together.
 */
export async function receivePurchase(
  input: unknown,
): Promise<ActionResult<{ receivedCount: number }>> {
  try {
    const parsed = receivePurchaseSchema.parse(input);
    const auth = await requireTenant();

    const client = await supabase();
    const { data, error } = await client.rpc('receive_purchase', {
      p_purchase_id: parsed.purchaseId,
      p_items: parsed.items.map((item) => ({
        product_id: item.productId,
        quantity: item.quantity,
        unit_cost: item.unitCost,
      })),
    });

    if (error) throw error;

    log.info('purchase received', {
      tenantId: auth.tenant.tenantId,
      purchaseId: parsed.purchaseId,
      lines: parsed.items.length,
    });

    revalidatePath('/purchases');
    revalidatePath(`/purchases/${parsed.purchaseId}`);
    revalidatePath('/inventory');
    revalidatePath('/');

    return actionOk({ receivedCount: data?.[0]?.received_count ?? 0 });
  } catch (error) {
    return toActionResult(error);
  }
}

// --- Stock transfers ---------------------------------------------------------------------

export async function createTransfer(
  input: unknown,
): Promise<ActionResult<{ transferId: string; reference: string }>> {
  try {
    const parsed = createTransferSchema.parse(input);
    await requireTenant();

    const client = await supabase();
    const { data, error } = await client.rpc('create_stock_transfer', {
      p_from_branch_id: parsed.fromBranchId,
      p_to_branch_id: parsed.toBranchId,
      p_items: parsed.items.map((item) => ({
        product_id: item.productId,
        quantity: item.quantity,
      })),
      p_notes: parsed.notes,
    });

    if (error) throw error;
    const row = data?.[0];
    if (!row?.transfer_id) throw new Error('create_stock_transfer returned no row');

    revalidatePath('/transfers');
    return actionOk({ transferId: row.transfer_id, reference: row.reference ?? '' });
  } catch (error) {
    return toActionResult(error);
  }
}

/** Sends the goods. Stock leaves the source branch here, not on receipt. */
export async function dispatchTransfer(
  input: unknown,
): Promise<ActionResult<{ dispatchedCount: number }>> {
  try {
    const { transferId } = transferActionSchema.parse(input);
    await requireTenant();

    const client = await supabase();
    const { data, error } = await client.rpc('dispatch_stock_transfer', {
      p_transfer_id: transferId,
    });
    if (error) throw error;

    revalidatePath('/transfers');
    revalidatePath(`/transfers/${transferId}`);
    revalidatePath('/inventory');
    return actionOk({ dispatchedCount: data?.[0]?.dispatched_count ?? 0 });
  } catch (error) {
    return toActionResult(error);
  }
}

export async function receiveTransfer(
  input: unknown,
): Promise<ActionResult<{ receivedCount: number }>> {
  try {
    const parsed = receiveTransferSchema.parse(input);
    await requireTenant();

    const client = await supabase();
    const { data, error } = await client.rpc('receive_stock_transfer', {
      p_transfer_id: parsed.transferId,
      // Omitted means "everything that was sent". A shortfall is recorded rather than
      // silently absorbed.
      p_received: parsed.received?.map((item) => ({
        product_id: item.productId,
        quantity: item.quantity,
      })),
    });
    if (error) throw error;

    revalidatePath('/transfers');
    revalidatePath(`/transfers/${parsed.transferId}`);
    revalidatePath('/inventory');
    return actionOk({ receivedCount: data?.[0]?.received_count ?? 0 });
  } catch (error) {
    return toActionResult(error);
  }
}

export async function cancelTransfer(
  input: unknown,
): Promise<ActionResult<{ transferId: string }>> {
  try {
    const parsed = cancelTransferSchema.parse(input);
    await requireTenant();

    const client = await supabase();
    const { error } = await client.rpc('cancel_stock_transfer', {
      p_transfer_id: parsed.transferId,
      p_reason: parsed.reason,
    });
    if (error) throw error;

    revalidatePath('/transfers');
    return actionOk({ transferId: parsed.transferId });
  } catch (error) {
    return toActionResult(error);
  }
}
