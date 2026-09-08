/**
 * Branded identifiers.
 *
 * Every identifier in Carl is a UUID, which means every identifier is structurally a string,
 * which means nothing stops `getBranch(productId)` from compiling. In a multi-tenant system
 * that class of mistake is a data-leak, not a typo — passing a `TenantId` where a `BranchId`
 * belongs is exactly how one business ends up reading another's stock.
 *
 * Branding costs nothing at runtime (these are plain strings) and makes those swaps a
 * compile error.
 */

import { randomUuid } from './encoding.js';

declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

export type TenantId = Brand<string, 'TenantId'>;
export type BranchId = Brand<string, 'BranchId'>;
export type UserId = Brand<string, 'UserId'>;
export type MembershipId = Brand<string, 'MembershipId'>;
export type RoleId = Brand<string, 'RoleId'>;
export type DeviceId = Brand<string, 'DeviceId'>;
export type ProductId = Brand<string, 'ProductId'>;
export type VariantId = Brand<string, 'VariantId'>;
export type CategoryId = Brand<string, 'CategoryId'>;
export type CustomerId = Brand<string, 'CustomerId'>;
export type SupplierId = Brand<string, 'SupplierId'>;
export type SaleId = Brand<string, 'SaleId'>;
export type SaleItemId = Brand<string, 'SaleItemId'>;
export type PaymentId = Brand<string, 'PaymentId'>;
export type ReturnId = Brand<string, 'ReturnId'>;
export type PurchaseId = Brand<string, 'PurchaseId'>;
export type ExpenseId = Brand<string, 'ExpenseId'>;
export type TransferId = Brand<string, 'TransferId'>;
export type StockCountId = Brand<string, 'StockCountId'>;
export type CashSessionId = Brand<string, 'CashSessionId'>;
export type RegisterId = Brand<string, 'RegisterId'>;
export type InventoryMovementId = Brand<string, 'InventoryMovementId'>;
export type AuditLogId = Brand<string, 'AuditLogId'>;
export type SubscriptionId = Brand<string, 'SubscriptionId'>;

/** A client-generated key that makes a write safe to retry. See `idempotency.ts`. */
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Tags a validated UUID string as a specific identifier type.
 *
 * Only call this at a trust boundary where the value has just been validated — parsing a
 * database row, or after a Zod schema has accepted request input. Casting arbitrary strings
 * here defeats the point of branding.
 */
export function asId<T extends string>(value: string): Brand<string, T> {
  return value as Brand<string, T>;
}

/** Generates a v4 UUID using the platform CSPRNG. */
export function newId<T extends string>(): Brand<string, T> {
  return randomUuid() as Brand<string, T>;
}

export const newTenantId = (): TenantId => newId<'TenantId'>();
export const newBranchId = (): BranchId => newId<'BranchId'>();
export const newProductId = (): ProductId => newId<'ProductId'>();
export const newSaleId = (): SaleId => newId<'SaleId'>();
export const newDeviceId = (): DeviceId => newId<'DeviceId'>();
