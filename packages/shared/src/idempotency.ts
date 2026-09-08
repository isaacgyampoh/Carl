/**
 * Idempotency.
 *
 * Carl's most important write — completing a sale — travels over networks that fail. A
 * cashier on a weak connection taps "Complete", the request reaches the server, the response
 * is lost, and the client retries. Without protection, the customer is charged twice and
 * stock drops twice.
 *
 * Offline sync makes this certain rather than merely likely: a desktop terminal replays its
 * queue after a reconnect, and a partially-acknowledged batch will be re-sent.
 *
 * The rule: **the client generates a key before the first attempt and reuses it for every
 * retry of that same logical operation.** The server records the key with the result. A
 * second arrival returns the original outcome instead of performing the work again.
 */

import { randomUuid } from './encoding.js';
import { type IdempotencyKey, asId } from './ids.js';

/**
 * Generates a key for a new logical operation.
 *
 * Must be called once, when the operation is first composed — not per attempt. A key
 * generated inside a retry loop provides no protection at all.
 */
export function newIdempotencyKey(): IdempotencyKey {
  return asId<'IdempotencyKey'>(randomUuid());
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function isValidIdempotencyKey(value: unknown): value is IdempotencyKey {
  return typeof value === 'string' && KEY_PATTERN.test(value);
}

/**
 * How a repeated request was resolved.
 *
 * `replayed` matters to the caller: the operation succeeded, but *this* attempt did not cause
 * it. A sync engine uses that to mark a queued transaction complete without double-counting.
 */
export type IdempotentOutcome<T> =
  | { readonly status: 'executed'; readonly value: T }
  | { readonly status: 'replayed'; readonly value: T };

export function executed<T>(value: T): IdempotentOutcome<T> {
  return { status: 'executed', value };
}

export function replayed<T>(value: T): IdempotentOutcome<T> {
  return { status: 'replayed', value };
}

/**
 * A stable fingerprint of a request payload.
 *
 * Guards against a client reusing a key for a *different* request — accidentally, or as an
 * attempt to have a cheap sale's response returned for an expensive one. The server stores
 * this alongside the key and rejects a mismatch rather than replaying the wrong result.
 *
 * Object keys are sorted so that logically identical payloads fingerprint identically
 * regardless of serialisation order.
 */
export function fingerprint(payload: unknown): string {
  return stableStringify(payload);
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
