/**
 * Schemas for catalogue, customer and supplier mutations.
 *
 * These validate shape and plausibility so a malformed request fails with a precise
 * message. They are not the security boundary: the database re-validates everything
 * through constraints and RLS, and a caller bypassing this form entirely meets exactly
 * the same rules.
 *
 * Note the pricing fields. A retail price *is* accepted here — a product's price is
 * something an authorised user sets deliberately, unlike a checkout price, which is never
 * accepted from a client. The two are different operations and only one of them takes a
 * price from the caller.
 */

import { z } from 'zod';

import {
  barcodeSchema,
  emailSchema,
  mediumTextSchema,
  minorAmountSchema,
  phoneSchema,
  quantitySchema,
  shortTextSchema,
  skuSchema,
  uuidSchema,
} from './primitives';

export const taxModeSchema = z.enum(['INCLUSIVE', 'EXCLUSIVE', 'EXEMPT']);

export const productSchema = z
  .object({
    name: shortTextSchema,
    sku: skuSchema,
    categoryId: uuidSchema.optional().nullable(),
    description: mediumTextSchema.optional().nullable(),
    unit: z.string().trim().min(1).max(32).default('unit'),
    /** Weighed goods. A shop cannot sell half a bottle, and allowing it breaks stock-take. */
    allowFractional: z.boolean().default(false),
    isStockTracked: z.boolean().default(true),
    isActive: z.boolean().default(true),

    /** Set deliberately by an authorised user; not a checkout price. */
    retailPrice: minorAmountSchema,
    wholesalePrice: minorAmountSchema.optional(),
    /** The starting cost, used until a purchase updates the weighted average. */
    costPrice: minorAmountSchema.default(0),

    reorderLevel: quantitySchema.min(0).default(0),
    minStock: quantitySchema.min(0).default(0),

    taxMode: taxModeSchema.default('INCLUSIVE'),
    taxRate: z.number().min(0).max(100).optional(),

    barcode: barcodeSchema.optional(),
    imageUrl: z.url().optional().nullable(),
  })
  .refine((p) => p.taxMode === 'EXEMPT' || p.taxRate !== undefined, {
    error: 'A taxed product needs a rate.',
    path: ['taxRate'],
  })
  .refine((p) => p.wholesalePrice === undefined || p.wholesalePrice <= p.retailPrice, {
    // Not a database rule, but selling wholesale above retail is almost always a keying
    // error, and catching it here saves someone discovering it at the till.
    error: 'The wholesale price is above the retail price. Check the figures.',
    path: ['wholesalePrice'],
  });

/**
 * Two types, because they genuinely differ.
 *
 * `ProductFormValues` is what a form holds *before* validation, where fields carrying a
 * `.default()` may be absent. `ProductInput` is what comes out, where they are present.
 * React Hook Form needs both, and collapsing them forces a cast that hides real mismatches.
 */
export type ProductFormValues = z.input<typeof productSchema>;
export type ProductInput = z.output<typeof productSchema>;

export const updateProductSchema = z.object({
  productId: uuidSchema,
  patch: productSchema,
});

export const setProductActiveSchema = z.object({
  productId: uuidSchema,
  isActive: z.boolean(),
});

export const customerSchema = z.object({
  name: shortTextSchema,
  phone: phoneSchema.optional().nullable(),
  email: emailSchema.optional().nullable(),
  address: mediumTextSchema.optional().nullable(),
  notes: mediumTextSchema.optional().nullable(),
  defaultTier: z.enum(['RETAIL', 'WHOLESALE']).default('RETAIL'),
  creditLimit: minorAmountSchema.default(0),
});

export type CustomerFormValues = z.input<typeof customerSchema>;
export type CustomerInput = z.output<typeof customerSchema>;

export const updateCustomerSchema = z.object({
  customerId: uuidSchema,
  patch: customerSchema,
});

export const supplierSchema = z.object({
  name: shortTextSchema,
  contactName: shortTextSchema.optional().nullable(),
  phone: phoneSchema.optional().nullable(),
  email: emailSchema.optional().nullable(),
  address: mediumTextSchema.optional().nullable(),
  notes: mediumTextSchema.optional().nullable(),
  paymentTermsDays: z.number().int().min(0).max(365).default(0),
});

export type SupplierFormValues = z.input<typeof supplierSchema>;
export type SupplierInput = z.output<typeof supplierSchema>;

export const updateSupplierSchema = z.object({
  supplierId: uuidSchema,
  patch: supplierSchema,
});

export const categorySchema = z.object({
  name: shortTextSchema,
  description: mediumTextSchema.optional().nullable(),
});

// --- Purchasing -------------------------------------------------------------------------

export const purchaseLineSchema = z.object({
  productId: uuidSchema,
  quantity: z.number().positive().max(1_000_000),
  /** What the supplier charges. Distinct from a selling price in every way that matters. */
  unitCost: minorAmountSchema,
});

export const createPurchaseSchema = z.object({
  branchId: uuidSchema,
  supplierId: uuidSchema.optional().nullable(),
  supplierInvoiceNo: z.string().trim().max(64).optional(),
  items: z
    .array(purchaseLineSchema)
    .min(1, { error: 'Add at least one product to the purchase.' })
    .max(500),
  notes: mediumTextSchema.optional(),
  expectedAt: z.iso.date().optional(),
});

export const receivePurchaseSchema = z.object({
  purchaseId: uuidSchema,
  items: z
    .array(
      z.object({
        productId: uuidSchema,
        quantity: z.number().positive().max(1_000_000),
        unitCost: minorAmountSchema,
      }),
    )
    .min(1, { error: 'Record what actually arrived.' }),
});

// --- Stock transfers --------------------------------------------------------------------

export const createTransferSchema = z
  .object({
    fromBranchId: uuidSchema,
    toBranchId: uuidSchema,
    items: z
      .array(
        z.object({
          productId: uuidSchema,
          quantity: z.number().positive().max(1_000_000),
        }),
      )
      .min(1, { error: 'Add at least one product to the transfer.' }),
    notes: mediumTextSchema.optional(),
  })
  .refine((t) => t.fromBranchId !== t.toBranchId, {
    error: 'A transfer must be between two different branches.',
    path: ['toBranchId'],
  });

export const transferActionSchema = z.object({
  transferId: uuidSchema,
});

export const receiveTransferSchema = z.object({
  transferId: uuidSchema,
  /** What actually arrived. Omitted means everything that was sent. */
  received: z
    .array(z.object({ productId: uuidSchema, quantity: z.number().min(0).max(1_000_000) }))
    .optional(),
});

export const cancelTransferSchema = z.object({
  transferId: uuidSchema,
  reason: z.string().trim().min(3).max(200),
});
