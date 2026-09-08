/**
 * Carl's structured error vocabulary.
 *
 * "Something went wrong" is not an acceptable message for a cashier holding a queue of
 * customers. Every failure carries a stable machine-readable code so the UI can say something
 * true and specific, the desktop sync engine can decide whether to retry, and support can
 * search logs for it.
 *
 * Codes are also emitted by PostgreSQL functions (as the SQLSTATE message), which keeps a
 * single vocabulary across the database, the server and the client.
 */
export const ErrorCode = {
  // --- Authentication & authorization ---
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN_TENANT: 'FORBIDDEN_TENANT',
  FORBIDDEN_BRANCH: 'FORBIDDEN_BRANCH',
  PERMISSION_DENIED: 'PERMISSION_DENIED',

  // --- Tenancy & subscription ---
  TENANT_NOT_FOUND: 'TENANT_NOT_FOUND',
  TENANT_SUSPENDED: 'TENANT_SUSPENDED',
  TENANT_CANCELLED: 'TENANT_CANCELLED',
  SUBSCRIPTION_EXPIRED: 'SUBSCRIPTION_EXPIRED',

  // --- Devices ---
  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  DEVICE_NOT_ACTIVATED: 'DEVICE_NOT_ACTIVATED',
  DEVICE_AUTHORIZATION_EXPIRED: 'DEVICE_AUTHORIZATION_EXPIRED',
  ACTIVATION_CODE_INVALID: 'ACTIVATION_CODE_INVALID',
  ACTIVATION_CODE_EXPIRED: 'ACTIVATION_CODE_EXPIRED',
  ACTIVATION_CODE_CONSUMED: 'ACTIVATION_CODE_CONSUMED',

  // --- Catalogue & pricing ---
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  PRODUCT_INACTIVE: 'PRODUCT_INACTIVE',
  INVALID_PRICE: 'INVALID_PRICE',
  PRICE_NOT_CONFIGURED: 'PRICE_NOT_CONFIGURED',
  DISCOUNT_NOT_PERMITTED: 'DISCOUNT_NOT_PERMITTED',
  DISCOUNT_EXCEEDS_LIMIT: 'DISCOUNT_EXCEEDS_LIMIT',

  // --- Inventory ---
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  NEGATIVE_STOCK_NOT_ALLOWED: 'NEGATIVE_STOCK_NOT_ALLOWED',
  INVALID_QUANTITY: 'INVALID_QUANTITY',
  STOCK_TRANSFER_INVALID_STATE: 'STOCK_TRANSFER_INVALID_STATE',
  STOCK_COUNT_ALREADY_CLOSED: 'STOCK_COUNT_ALREADY_CLOSED',

  // --- Sales & payment ---
  SALE_NOT_FOUND: 'SALE_NOT_FOUND',
  SALE_ALREADY_VOIDED: 'SALE_ALREADY_VOIDED',
  EMPTY_CART: 'EMPTY_CART',
  PAYMENT_INCOMPLETE: 'PAYMENT_INCOMPLETE',
  PAYMENT_EXCEEDS_TOTAL: 'PAYMENT_EXCEEDS_TOTAL',
  PAYMENT_REFERENCE_REQUIRED: 'PAYMENT_REFERENCE_REQUIRED',
  CHANGE_NOT_PERMITTED: 'CHANGE_NOT_PERMITTED',

  // --- Returns ---
  RETURN_EXCEEDS_SOLD_QUANTITY: 'RETURN_EXCEEDS_SOLD_QUANTITY',
  RETURN_WINDOW_EXPIRED: 'RETURN_WINDOW_EXPIRED',
  REFUND_EXCEEDS_PAID: 'REFUND_EXCEEDS_PAID',

  // --- Cash register ---
  REGISTER_ALREADY_OPEN: 'REGISTER_ALREADY_OPEN',
  REGISTER_NOT_OPEN: 'REGISTER_NOT_OPEN',
  REGISTER_SESSION_CLOSED: 'REGISTER_SESSION_CLOSED',

  // --- Offline synchronisation ---
  DUPLICATE_TRANSACTION: 'DUPLICATE_TRANSACTION',
  SYNC_CONFLICT: 'SYNC_CONFLICT',
  SYNC_PAYLOAD_INVALID: 'SYNC_PAYLOAD_INVALID',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',

  // --- Generic ---
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Additional context attached to an error. Must never contain secrets or full card data. */
export type ErrorDetails = Record<string, string | number | boolean | null | undefined>;

export interface CarlErrorShape {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: ErrorDetails;
}

/**
 * The single error type crossing Carl's application boundary.
 *
 * `message` is safe to show a user. Anything sensitive belongs in the server log, not here.
 */
export class CarlError extends Error implements CarlErrorShape {
  public readonly code: ErrorCode;
  public readonly details?: ErrorDetails;

  constructor(code: ErrorCode, message: string, details?: ErrorDetails) {
    super(message);
    this.name = 'CarlError';
    this.code = code;
    if (details !== undefined) this.details = details;
    Object.setPrototypeOf(this, CarlError.prototype);
  }

  toJSON(): CarlErrorShape {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export function carlError(code: ErrorCode, message: string, details?: ErrorDetails): CarlError {
  return new CarlError(code, message, details);
}

export function isCarlError(value: unknown): value is CarlError {
  return value instanceof CarlError;
}

/**
 * Recognises a Carl error code embedded in a PostgreSQL error message.
 *
 * Database functions raise exceptions whose MESSAGE is the bare error code, so a failure
 * inside `complete_sale()` surfaces to the client with the same vocabulary as one raised in
 * TypeScript.
 */
export function errorCodeFromMessage(message: string): ErrorCode | null {
  const candidate = message.trim().split(/[\s:]/, 1)[0];
  if (candidate === undefined) return null;
  return candidate in ErrorCode ? (candidate as ErrorCode) : null;
}
