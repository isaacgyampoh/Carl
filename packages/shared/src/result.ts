/**
 * A explicit success/failure value.
 *
 * Carl uses `Result` rather than exceptions for *expected* failures — insufficient stock,
 * an incomplete payment, a revoked device. Those are ordinary business outcomes that every
 * caller must handle, and the type system should force them to. Exceptions remain reserved
 * for genuine defects (a broken invariant, a database that is unreachable).
 */
export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export function ok(): Ok<void>;
export function ok<T>(value: T): Ok<T>;
export function ok<T>(value?: T): Ok<T | undefined> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Applies `fn` to a success value, leaving a failure untouched. */
export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Chains an operation that may itself fail. */
export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

/**
 * Unwraps a success value, throwing on failure.
 *
 * Only for code paths that have already proven the result is a success — a test, or a branch
 * guarded by `isOk`. Reaching for this to avoid handling an error is how a POS ends up
 * swallowing a failed sale.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw new Error(`Called unwrap() on a failed Result: ${JSON.stringify(result.error)}`);
}

/** Collects many results, failing on the first error encountered. */
export function collect<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}
