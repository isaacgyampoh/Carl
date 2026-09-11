'use server';

import { revalidatePath } from 'next/cache';
import { ErrorCode } from '@carl/shared';
import { z } from '@carl/validation';

import { currentAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { actionFailed, actionOk, toActionResult, type ActionResult } from './errors';

/**
 * What a person means, mapped to what the ledger records.
 *
 * A shopkeeper thinks "add stock", "some were damaged", not in movement types, and should
 * never have to type a minus sign. The direction lives here, once, rather than in a form.
 */
const KINDS = {
  ADD: ['ADJUSTMENT_IN', 1],
  REMOVE: ['ADJUSTMENT_OUT', -1],
  DAMAGE: ['DAMAGE', -1],
  EXPIRED: ['EXPIRED', -1],
  THEFT: ['THEFT', -1],
  OPENING: ['OPENING_STOCK', 1],
} as const;

export type StockAdjustmentKind = keyof typeof KINDS;

const adjustSchema = z.object({
  branchId: z.uuid(),
  productId: z.uuid(),
  kind: z.enum(['ADD', 'REMOVE', 'DAMAGE', 'EXPIRED', 'THEFT', 'OPENING']),
  quantity: z.number().positive('Enter a quantity above zero.').max(1_000_000_000),
  // The ledger requires a reason: an unexplained adjustment is indistinguishable from theft.
  reason: z.string().trim().min(3, 'Say why, in a few words.').max(300),
});

/**
 * Records a change to stock at a branch.
 *
 * Stock previously entered Carl only by receiving a purchase order or a transfer: nothing in
 * the app called `apply_stock_adjustment`, so a client who added a product could not sell it
 * until they had raised and received a purchase. The inventory page even said "record
 * opening stock to get started" with no way to do so.
 *
 * `apply_stock_adjustment` enforces the rules: `inventory.adjust` at that branch, access to
 * the branch, a business allowed to transact, a reason, and no stock below zero.
 */
export async function adjustStock(input: unknown): Promise<ActionResult<{ newQuantity: number }>> {
  try {
    const parsed = adjustSchema.parse(input);
    const auth = await currentAuth();
    if (!auth?.tenant) return actionFailed(ErrorCode.UNAUTHENTICATED, 'Sign in first.');

    const [movementType, direction] = KINDS[parsed.kind];
    const client = await supabase();
    const { data, error } = await client.rpc('apply_stock_adjustment', {
      p_branch_id: parsed.branchId,
      p_product_id: parsed.productId,
      p_quantity: direction * parsed.quantity,
      p_movement_type: movementType,
      p_reason: parsed.reason,
    });
    if (error) throw error;

    revalidatePath('/inventory');
    revalidatePath('/products');
    revalidatePath(`/products/${parsed.productId}`);
    revalidatePath('/dashboard');
    return actionOk({ newQuantity: Number(data?.[0]?.new_quantity ?? 0) });
  } catch (error) {
    const code = (error as { message?: string } | null)?.message;
    if (code === 'INSUFFICIENT_STOCK') {
      return actionFailed(ErrorCode.INSUFFICIENT_STOCK, 'That would take stock below zero.');
    }
    if (code === 'FORBIDDEN_BRANCH') {
      return actionFailed(ErrorCode.FORBIDDEN_BRANCH, 'You do not have access to that branch.');
    }
    return toActionResult(error);
  }
}
