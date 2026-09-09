import { type NextResponse } from 'next/server';
import { z } from '@carl/validation';

import { bearerClient } from '@carl/infrastructure/supabase/server-client';
import { badRequest, deviceCredential, deviceError, log, ok, pepper } from '../route-support';

/**
 * Where an offline sale reaches the server.
 *
 * ## What the terminal is not allowed to say
 *
 * A line carries a product, a quantity and possibly a discount. It does not carry a price,
 * a line total, a tax amount or an order total, and there is no field here to put one in.
 * The server prices the sale from its own catalogue exactly as it would online — the same
 * `complete_sale`, reached through `sync_offline_sale`, so an offline sale cannot be a
 * cheaper path than an online one.
 *
 * The one thing the terminal is trusted with is *when* the sale happened, because only it
 * knows. That trust is bounded: the database rejects a sale stamped in the future, and the
 * terminal corrects its clock against the server on every sync.
 *
 * ## Idempotency
 *
 * `idempotencyKey` is generated once, when the cashier finishes the sale, and reused for
 * every retry forever. That is the whole reason a terminal can resend safely after a
 * connection dies mid-request without knowing whether the sale landed.
 */
export const dynamic = 'force-dynamic';

const line = z.object({
  product_id: z.uuid(),
  quantity: z.number().finite().positive(),
  discount_type: z.enum(['PERCENTAGE', 'AMOUNT']).optional(),
  discount_value: z.number().finite().nonnegative().optional(),
});

const payment = z.object({
  // Exactly the database's payment_method enum. A value it does not know would be
  // rejected far downstream, after the sale had already been accepted as valid here.
  method: z.enum(['CASH', 'MOMO', 'BANK_TRANSFER', 'CARD', 'CREDIT', 'OTHER']),
  amount: z.number().int().nonnegative(),
  reference: z.string().trim().max(120).optional(),
});

const schema = deviceCredential.extend({
  /**
   * The cashier's Supabase access token.
   *
   * A sale is attributed to a person, and `complete_sale` checks that person holds
   * `sales.create` at this branch — so an authorised terminal is necessary and not
   * sufficient. Running this as the service role instead would attribute every offline
   * sale to nobody and skip every permission check the database makes, which is exactly
   * the shortcut that turns a shared till into an unaudited one.
   */
  accessToken: z.string().min(20),
  idempotencyKey: z.string().trim().min(8).max(200),
  branchId: z.uuid(),
  soldAt: z.iso.datetime(),
  items: z.array(line).min(1).max(500),
  payments: z.array(payment).min(1).max(10),
  customerId: z.uuid().nullish(),
  tier: z.enum(['RETAIL', 'WHOLESALE']).default('RETAIL'),
  orderDiscountType: z.enum(['NONE', 'PERCENTAGE', 'AMOUNT']).default('NONE'),
  orderDiscountValue: z.number().finite().nonnegative().nullish(),
  note: z.string().trim().max(500).nullish(),
});

export async function POST(request: Request): Promise<NextResponse> {
  let parsed: z.infer<typeof schema>;
  try {
    parsed = schema.parse(await request.json());
  } catch (error) {
    if (error instanceof z.ZodError) return badRequest(error.issues.map((i) => i.message));
    return badRequest('A JSON body is required.');
  }

  try {
    const { data, error } = await bearerClient(parsed.accessToken).rpc('sync_offline_sale', {
      p_branch_id: parsed.branchId,
      p_items: parsed.items,
      p_payments: parsed.payments,
      p_idempotency_key: parsed.idempotencyKey,
      p_sold_at: parsed.soldAt,
      p_device_id: parsed.deviceId,
      p_device_secret: parsed.deviceSecret,
      p_pepper: pepper(),
      p_customer_id: parsed.customerId ?? undefined,
      p_tier: parsed.tier,
      p_order_discount_type: parsed.orderDiscountType,
      p_order_discount_value: parsed.orderDiscountValue ?? undefined,
      p_note: parsed.note ?? undefined,
    });
    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.sale_id) throw new Error('sync_offline_sale returned no sale');

    log.info('offline sale synced', {
      deviceId: parsed.deviceId,
      saleId: row.sale_id,
      // Distinguishes a genuine new sale from a resend, which is the number that matters
      // when a shop asks why a day's takings look different from the till's own count.
      replayed: row.was_replayed,
      conflict: row.had_conflict,
    });

    return ok({
      saleId: row.sale_id,
      saleNumber: row.sale_number,
      total: row.total,
      replayed: row.was_replayed,
      hadConflict: row.had_conflict,
      conflictId: row.conflict_id,
    });
  } catch (error) {
    return deviceError(error, { deviceId: parsed.deviceId, route: 'sync' });
  }
}
