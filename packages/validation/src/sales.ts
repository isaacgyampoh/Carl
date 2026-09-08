/**
 * Schemas for point-of-sale requests.
 *
 * ## What is deliberately absent
 *
 * There is no schema for a unit price, a line total, an order total, a tax amount or a
 * tenant id. Those are never accepted from a client — the server derives them. Adding a
 * schema for one would legitimise sending it, and the next person to read this file would
 * reasonably assume a validated price is a trusted price.
 *
 * What *is* validated here is shape and plausibility, so a malformed request fails with a
 * precise message instead of a database error. The database validates it again regardless.
 */

import { z } from 'zod';

import { idempotencyKeySchema, mediumTextSchema, uuidSchema } from './primitives';

export const priceTierSchema = z.enum(['RETAIL', 'WHOLESALE']);

export const discountKindSchema = z.enum(['PERCENTAGE', 'AMOUNT']);

export const paymentMethodSchema = z.enum([
  'CASH',
  'MOMO',
  'BANK_TRANSFER',
  'CARD',
  'CREDIT',
  'OTHER',
]);

/**
 * A discount as the client expresses it.
 *
 * The value means different things per kind — a percentage, or minor units — so the two
 * are validated separately rather than as one loose number.
 */
export const discountSchema = z
  .object({
    type: discountKindSchema,
    value: z.number().positive(),
  })
  .refine((d) => d.type !== 'PERCENTAGE' || d.value <= 100, {
    error: 'A percentage discount cannot exceed 100%.',
    path: ['value'],
  })
  .refine((d) => d.type !== 'AMOUNT' || Number.isInteger(d.value), {
    error: 'A fixed discount must be a whole number of pesewas.',
    path: ['value'],
  });

export const cartItemSchema = z.object({
  product_id: uuidSchema,
  /**
   * Decimal units, matching the database's numeric(14,3).
   *
   * Capped at three decimal places because that is the precision the column stores;
   * accepting more would silently round and produce a total the cashier did not expect.
   */
  quantity: z
    .number()
    .positive({ error: 'Quantity must be greater than zero.' })
    .max(1_000_000, { error: 'That quantity is implausibly large.' })
    .refine((q) => Number.isInteger(q * 1000), {
      error: 'Quantity is limited to three decimal places.',
    }),
  discount_type: discountKindSchema.optional(),
  discount_value: z.number().positive().optional(),
});

export const tenderSchema = z
  .object({
    method: paymentMethodSchema,
    amount: z
      .number()
      .int({ error: 'Payment amounts are in whole pesewas.' })
      .positive({ error: 'A payment must be greater than zero.' }),
    reference: z.string().trim().max(120).optional(),
  })
  .refine(
    (payment) =>
      !['MOMO', 'BANK_TRANSFER'].includes(payment.method) ||
      (payment.reference !== undefined && payment.reference.length > 0),
    {
      // Carl does not integrate a mobile money API, so this reference is the only link to
      // the actual transfer. Without it the payment cannot be reconciled.
      error: 'A transaction reference is required for mobile money and bank transfers.',
      path: ['reference'],
    },
  );

export const completeSaleSchema = z.object({
  branchId: uuidSchema,
  items: z
    .array(cartItemSchema)
    .min(1, { error: 'Add at least one item before completing the sale.' })
    // A basket beyond this is a runaway loop or an attack, not a customer.
    .max(500, { error: 'That is too many lines for one sale.' }),
  payments: z
    .array(tenderSchema)
    .min(1, { error: 'Record how the customer paid.' })
    .max(10, { error: 'Too many separate payments on one sale.' }),
  idempotencyKey: idempotencyKeySchema,
  tier: priceTierSchema.default('RETAIL'),
  customerId: uuidSchema.optional(),
  orderDiscount: discountSchema.optional(),
  discountReason: mediumTextSchema.optional(),
  note: mediumTextSchema.optional(),
  /** Present only for a sale recorded offline and synced later. */
  soldAt: z.iso.datetime().optional(),
  deviceId: uuidSchema.optional(),
});

export type CompleteSaleInput = z.infer<typeof completeSaleSchema>;

export const returnItemSchema = z.object({
  sale_item_id: uuidSchema,
  quantity: z.number().positive().max(1_000_000),
  condition: z.enum(['RESALEABLE', 'DAMAGED', 'EXPIRED']).default('RESALEABLE'),
});

export const processReturnSchema = z.object({
  saleId: uuidSchema,
  items: z.array(returnItemSchema).min(1, { error: 'Select at least one item to return.' }),
  reason: z.string().trim().min(3, { error: 'Give a reason of at least 3 characters.' }).max(500),
  idempotencyKey: idempotencyKeySchema,
  refundMethod: paymentMethodSchema.optional(),
  refundReference: z.string().trim().max(120).optional(),
  /** Whether the goods go back on the shelf. Damaged stock must not be resold. */
  restocked: z.boolean().default(true),
  notes: mediumTextSchema.optional(),
});

export type ProcessReturnInput = z.infer<typeof processReturnSchema>;

export const voidSaleSchema = z.object({
  saleId: uuidSchema,
  reason: z.string().trim().min(3, { error: 'Give a reason of at least 3 characters.' }).max(500),
});

export const productSearchSchema = z.object({
  branchId: uuidSchema,
  query: z.string().trim().min(1).max(64),
  tier: priceTierSchema.default('RETAIL'),
  limit: z.number().int().positive().max(50).default(20),
});
