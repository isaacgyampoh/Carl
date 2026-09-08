/**
 * Translating PostgreSQL failures into Carl's error vocabulary.
 *
 * Two kinds of failure arrive from the database, and both must reach the user as something
 * actionable:
 *
 *   1. Deliberate rejections raised by Carl's own functions, whose message is a bare error
 *      code such as `INSUFFICIENT_STOCK`.
 *   2. Constraint violations raised by PostgreSQL itself. These are the safety net that
 *      catches whatever application validation missed — a duplicate barcode, a negative
 *      stock level, a foreign key to a deleted branch. They arrive as SQLSTATE codes.
 *
 * A raw constraint message ("duplicate key value violates unique constraint
 * products_tenant_id_sku_key") must never reach a cashier, but it must not be flattened to
 * "something went wrong" either.
 */

import { CarlError, ErrorCode, errorCodeFromMessage } from '@carl/shared';

/** The subset of a PostgREST/PostgreSQL error Carl inspects. */
export interface PostgresErrorLike {
  readonly code?: string | undefined;
  readonly message?: string | undefined;
  readonly details?: string | undefined;
  readonly hint?: string | undefined;
}

const SQLSTATE = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  EXCLUSION_VIOLATION: '23P01',
  INSUFFICIENT_PRIVILEGE: '42501',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  LOCK_NOT_AVAILABLE: '55P03',
  RAISE_EXCEPTION: 'P0001',
} as const;

export function isPostgresError(value: unknown): value is PostgresErrorLike {
  return typeof value === 'object' && value !== null && ('code' in value || 'message' in value);
}

/**
 * Maps a database failure to a `CarlError`.
 *
 * Unrecognised failures become `INTERNAL_ERROR` with a generic message: the original is
 * logged server-side, but its text is not echoed to the client, because constraint messages
 * disclose table and column names.
 */
export function toCarlError(error: unknown): CarlError {
  if (error instanceof CarlError) return error;

  if (!isPostgresError(error)) {
    return new CarlError(ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred.');
  }

  const message = error.message ?? '';

  // Carl's own functions raise the error code as the exception message.
  const explicit = errorCodeFromMessage(message);
  if (explicit) {
    return new CarlError(explicit, humanMessageFor(explicit));
  }

  switch (error.code) {
    case undefined:
      // No SQLSTATE at all — typically a transport failure rather than a database rejection.
      return new CarlError(ErrorCode.INTERNAL_ERROR, 'The database could not be reached.');
    case SQLSTATE.UNIQUE_VIOLATION:
      return new CarlError(
        ErrorCode.CONFLICT,
        'That value is already in use. Check for an existing record with the same code.',
        constraintDetail(error),
      );
    case SQLSTATE.FOREIGN_KEY_VIOLATION:
      return new CarlError(
        ErrorCode.VALIDATION_FAILED,
        'A referenced record does not exist or is still in use.',
        constraintDetail(error),
      );
    case SQLSTATE.CHECK_VIOLATION:
    case SQLSTATE.NOT_NULL_VIOLATION:
    case SQLSTATE.EXCLUSION_VIOLATION:
      return new CarlError(
        ErrorCode.VALIDATION_FAILED,
        'The submitted data failed a database rule.',
        constraintDetail(error),
      );
    case SQLSTATE.INSUFFICIENT_PRIVILEGE:
      // Row Level Security refused the write. Deliberately vague: confirming that a record
      // exists but is not yours is itself a disclosure.
      return new CarlError(
        ErrorCode.PERMISSION_DENIED,
        'You do not have permission to perform this action.',
      );
    case SQLSTATE.SERIALIZATION_FAILURE:
    case SQLSTATE.DEADLOCK_DETECTED:
    case SQLSTATE.LOCK_NOT_AVAILABLE:
      // Two terminals hit the same stock row at once. Safe and correct to retry.
      return new CarlError(
        ErrorCode.CONFLICT,
        'Another terminal changed this record at the same moment. Please try again.',
      );
    default:
      return new CarlError(ErrorCode.INTERNAL_ERROR, 'An unexpected database error occurred.');
  }
}

/** Whether retrying the identical operation could plausibly succeed. */
export function isRetryable(error: unknown): boolean {
  if (!isPostgresError(error)) return false;
  return (
    error.code === SQLSTATE.SERIALIZATION_FAILURE ||
    error.code === SQLSTATE.DEADLOCK_DETECTED ||
    error.code === SQLSTATE.LOCK_NOT_AVAILABLE
  );
}

/** Extracts only the constraint name — never the offending values, which may be personal data. */
function constraintDetail(error: PostgresErrorLike): { constraint: string } | undefined {
  const match = /constraint "([^"]+)"/.exec(error.message ?? '');
  return match?.[1] ? { constraint: match[1] } : undefined;
}

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  [ErrorCode.INSUFFICIENT_STOCK]: 'There is not enough stock at this branch to complete the sale.',
  [ErrorCode.PAYMENT_INCOMPLETE]: 'The payments received do not cover the sale total.',
  [ErrorCode.PAYMENT_EXCEEDS_TOTAL]: 'The payments received exceed the sale total.',
  [ErrorCode.EMPTY_CART]: 'Add at least one item before completing the sale.',
  [ErrorCode.DUPLICATE_TRANSACTION]: 'This transaction has already been recorded.',
  [ErrorCode.DEVICE_REVOKED]: 'This terminal has been revoked. Contact your administrator.',
  [ErrorCode.DEVICE_NOT_ACTIVATED]: 'This terminal has not been activated.',
  [ErrorCode.TENANT_SUSPENDED]: 'This account is suspended. Contact Carl support.',
  [ErrorCode.PERMISSION_DENIED]: 'You do not have permission to perform this action.',
  [ErrorCode.PRODUCT_NOT_FOUND]: 'That product could not be found.',
  [ErrorCode.PRODUCT_INACTIVE]: 'That product is no longer available for sale.',
  [ErrorCode.RETURN_EXCEEDS_SOLD_QUANTITY]:
    'You cannot return more of an item than was sold on this receipt.',
  [ErrorCode.DISCOUNT_EXCEEDS_LIMIT]: 'That discount exceeds the limit for your role.',
  [ErrorCode.REGISTER_NOT_OPEN]: 'Open a cash register before recording a sale.',
  [ErrorCode.SYNC_CONFLICT]:
    'This offline transaction conflicts with stock recorded elsewhere and needs review.',
};

export function humanMessageFor(code: ErrorCode): string {
  return MESSAGES[code] ?? 'The operation could not be completed.';
}
