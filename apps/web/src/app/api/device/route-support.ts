import 'server-only';

import { NextResponse } from 'next/server';
import { createLogger } from '@carl/shared';
import { z } from '@carl/validation';
import { serverEnv } from '@carl/infrastructure/config/server-env';

/**
 * Shared handling for the endpoints a till talks to.
 *
 * ## Why terminals get HTTP routes and not server actions
 *
 * The rest of Carl's writes are Next.js server actions, which are bound to a browser
 * session and its CSRF token. A terminal has neither. It authenticates as *itself*, with
 * the secret issued at activation, and it is not a browser.
 *
 * ## Why these routes exist at all, rather than the terminal calling PostgreSQL directly
 *
 * `activate_device`, `sync_offline_sale` and `device_catalogue` all take the pepper as an
 * argument, and the pepper is the one secret that never enters the database — it is what
 * keeps a stolen dump from yielding working credentials for every till in the estate. So
 * the pepper has to be applied somewhere that is neither the database nor the terminal.
 * That is here.
 *
 * A terminal therefore holds exactly one secret: its own. It cannot mint another
 * terminal's, and a stolen till cannot be used to forge activations.
 */

const log = createLogger({ level: 'info', base: { module: 'device-api' } });

/**
 * Database error codes mapped to HTTP status and a terminal-facing meaning.
 *
 * The distinction that matters to a till is retry-or-stop. A 5xx means "the connection or
 * the server is having a bad day, keep the sale queued and try later". A 4xx means "this
 * will never succeed, stop retrying and tell someone" — and for a queue that retries
 * automatically, getting that boundary wrong either loses a sale or hammers the server
 * forever.
 */
const OUTCOMES: Record<string, { status: number; retryable: boolean }> = {
  DEVICE_NOT_FOUND: { status: 401, retryable: false },
  DEVICE_NOT_ACTIVATED: { status: 401, retryable: false },
  DEVICE_REVOKED: { status: 403, retryable: false },
  DEVICE_AUTHORIZATION_EXPIRED: { status: 403, retryable: false },
  TENANT_SUSPENDED: { status: 403, retryable: false },
  ACTIVATION_CODE_INVALID: { status: 401, retryable: false },
  ACTIVATION_CODE_EXPIRED: { status: 401, retryable: false },
  ACTIVATION_CODE_CONSUMED: { status: 409, retryable: false },
  PERMISSION_DENIED: { status: 403, retryable: false },
  NOT_FOUND: { status: 404, retryable: false },
  VALIDATION_FAILED: { status: 422, retryable: false },
  SYNC_PAYLOAD_INVALID: { status: 422, retryable: false },
  INVALID_PRICE: { status: 422, retryable: false },
  INSUFFICIENT_STOCK: { status: 409, retryable: false },
  PAYMENT_MISMATCH: { status: 422, retryable: false },
};

export interface DeviceApiError {
  readonly error: string;
  readonly detail: string;
  readonly retryable: boolean;
}

/** The message a Supabase RPC failure carries, whatever shape it arrives in. */
function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message);
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turns a database failure into a response.
 *
 * Nothing from the database message reaches the terminal except the recognised code: a
 * raw PostgreSQL error can name tables, columns and constraint definitions, and a till is
 * not a place to disclose the schema. Unrecognised failures are logged in full and
 * reported as a plain 500.
 */
export function deviceError(error: unknown, context: Record<string, unknown>): NextResponse {
  const message = messageOf(error);
  const known = Object.keys(OUTCOMES).find((code) => message.includes(code));

  const outcome = known ? OUTCOMES[known] : undefined;
  if (known && outcome) {
    log.warn('device request refused', { ...context, code: known });
    return NextResponse.json<DeviceApiError>(
      { error: known, detail: known, retryable: outcome.retryable },
      { status: outcome.status, headers: { 'cache-control': 'no-store' } },
    );
  }

  log.error('device request failed', { ...context, message });
  return NextResponse.json<DeviceApiError>(
    // Retryable: an unrecognised failure is more often a transient one, and a queued sale
    // that keeps trying is recoverable where a discarded one is not.
    { error: 'INTERNAL', detail: 'The server could not complete the request.', retryable: true },
    { status: 500, headers: { 'cache-control': 'no-store' } },
  );
}

export function badRequest(issues: unknown): NextResponse {
  return NextResponse.json<DeviceApiError>(
    { error: 'VALIDATION_FAILED', detail: JSON.stringify(issues), retryable: false },
    { status: 400, headers: { 'cache-control': 'no-store' } },
  );
}

export function ok<T>(body: T): NextResponse {
  return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } });
}

/** The pepper, read here and nowhere a client can reach. */
export function pepper(): string {
  return serverEnv().CARL_DEVICE_SECRET_PEPPER;
}

/**
 * The credential every terminal request carries.
 *
 * In the body rather than a header only because it travels with a JSON payload anyway;
 * over TLS both are equivalent. It is never logged — `log` calls throughout these routes
 * pass `deviceId` and never `deviceSecret`.
 */
export const deviceCredential = z.object({
  deviceId: z.uuid(),
  deviceSecret: z.string().min(32).max(200),
});

export { log };
