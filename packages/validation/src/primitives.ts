/**
 * Shared Zod primitives.
 *
 * These schemas guard the application boundary. They are the *first* line of defence, never
 * the only one: a user who bypasses the UI entirely still meets PostgreSQL's constraints and
 * RLS policies. Validation here exists to give a fast, precise error rather than to keep the
 * database safe.
 *
 * Note what is deliberately absent: there is no schema for a price or a line total. Those are
 * never accepted from a client at all — the server derives them. A schema that validated a
 * client-supplied price would legitimise sending one.
 */

import { MAX_MINOR, MAX_QUANTITY } from '@carl/shared';
import { z } from 'zod';

export const uuidSchema = z.uuid({ error: 'Must be a valid identifier.' });

/** A monetary amount in minor units. Whole numbers only — see `@carl/shared/money`. */
export const minorAmountSchema = z
  .number()
  .int({ error: 'Amounts must be given in whole minor units (pesewas).' })
  .min(0, { error: 'Amount cannot be negative.' })
  .max(MAX_MINOR, { error: 'Amount is implausibly large.' });

/** A monetary amount that may be negative, e.g. a ledger adjustment. */
export const signedMinorAmountSchema = z
  .number()
  .int({ error: 'Amounts must be given in whole minor units (pesewas).' })
  .min(-MAX_MINOR)
  .max(MAX_MINOR);

/** A quantity in thousandths of a unit. */
export const quantitySchema = z
  .number()
  .int({ error: 'Quantity must be given in whole thousandths of a unit.' })
  .max(MAX_QUANTITY, { error: 'Quantity is implausibly large.' });

export const positiveQuantitySchema = quantitySchema.positive({
  error: 'Quantity must be greater than zero.',
});

/** A percentage between 0 and 100 inclusive, to two decimal places. */
export const percentageSchema = z
  .number()
  .min(0, { error: 'Percentage cannot be negative.' })
  .max(100, { error: 'Percentage cannot exceed 100.' })
  .multipleOf(0.01, { error: 'Percentage is limited to two decimal places.' });

/**
 * Human-entered free text.
 *
 * Trimmed and length-capped. Not HTML-escaped: React escapes on render, and escaping on
 * input would corrupt legitimate values (a product genuinely named "Tom & Jerry"). Escaping
 * belongs at the point of output, in the format the output requires.
 */
export const shortTextSchema = z
  .string()
  .trim()
  .min(1, { error: 'This field is required.' })
  .max(120);
export const mediumTextSchema = z.string().trim().max(500);
export const longTextSchema = z.string().trim().max(4000);

export const optionalShortText = shortTextSchema.optional().nullable();

export const emailSchema = z
  .email({ error: 'Enter a valid email address.' })
  .trim()
  .toLowerCase()
  .max(255);

/**
 * A phone number.
 *
 * Deliberately permissive: Carl operates in markets where numbers are written many ways, and
 * rejecting a customer's real number at the till to satisfy E.164 is a worse outcome than
 * storing "024 123 4567".
 */
export const phoneSchema = z
  .string()
  .trim()
  .min(7, { error: 'Enter a valid phone number.' })
  .max(32)
  .regex(/^[+()\d\s-]+$/, {
    error: 'A phone number may contain only digits, spaces, + ( ) and -.',
  });

/** A stock-keeping unit. Uppercased so lookups are predictable. */
export const skuSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(64)
  .regex(/^[A-Z0-9._-]+$/, {
    error: 'A SKU may contain only letters, digits, dot, dash and underscore.',
  });

/**
 * A scanned barcode.
 *
 * Length is capped generously rather than pinned to EAN-13, because shops routinely print
 * their own labels for loose goods and re-use supplier codes of varying lengths.
 */
export const barcodeSchema = z
  .string()
  .trim()
  .min(4, { error: 'A barcode must be at least 4 characters.' })
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, { error: 'That barcode contains unsupported characters.' });

export const isoDateTimeSchema = z.iso.datetime({ error: 'Must be an ISO-8601 timestamp.' });

/** An idempotency key. See `@carl/shared/idempotency` for why every write carries one. */
export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,128}$/, { error: 'Malformed idempotency key.' });

export const offsetPaginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(25),
});

export const cursorPaginationSchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().positive().max(200).default(25),
});

/** An inclusive date range, rejected if it runs backwards. */
export const dateRangeSchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .refine((range) => range.from <= range.to, {
    error: 'The start date must not be after the end date.',
    path: ['from'],
  });
