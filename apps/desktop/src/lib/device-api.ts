/**
 * The terminal's client for Carl's device endpoints.
 *
 * ## Why every call goes through the application server
 *
 * A till never talks to PostgreSQL. The functions behind these endpoints take the device
 * secret pepper as an argument, and the pepper is the one credential that exists in neither
 * the database nor the terminal — it is what stops a stolen database dump from yielding
 * working credentials for every till in the estate. So the terminal holds exactly one
 * secret: its own.
 *
 * ## Failure is classified, not thrown
 *
 * Every method returns a discriminated result rather than throwing, because the caller is
 * a sync engine deciding whether to retry. "The wifi is down" and "this device has been
 * revoked" both look like failure and must be handled in opposite ways: one keeps the sale
 * queued, the other stops the terminal.
 */

import type { SyncOutcome } from '@carl/sync';

export interface DeviceSession {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly deviceCode: string;
  readonly deviceName: string;
  readonly tenantName: string;
  readonly branchName: string;
  readonly deviceSecret: string;
  readonly authorizedUntil: string | null;
}

export interface ApiFailure {
  readonly error: string;
  readonly detail: string;
  readonly retryable: boolean;
}

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ApiFailure };

/** Errors that mean this terminal must stop, not retry. */
const FATAL = new Set([
  'DEVICE_REVOKED',
  'DEVICE_NOT_ACTIVATED',
  'DEVICE_NOT_FOUND',
  'DEVICE_AUTHORIZATION_EXPIRED',
  'TENANT_SUSPENDED',
]);

export interface DeviceApiOptions {
  readonly baseUrl: string;
  /** Injected so the transport can be tested without a network. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export class DeviceApi {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: DeviceApiOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async post<T>(path: string, body: unknown): Promise<ApiResult<T>> {
    const controller = new AbortController();
    // A till on a bad connection must not hang forever with a cashier waiting; the sale is
    // already safe on disk, so giving up quickly and retrying later costs nothing.
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20_000);

    try {
      const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.ok) return { ok: true, value: (await response.json()) as T };

      const failure = (await response.json().catch(() => null)) as ApiFailure | null;
      return {
        ok: false,
        failure: failure ?? {
          error: `HTTP_${response.status}`,
          detail: response.statusText,
          // 5xx is the server having a bad day; 4xx will never succeed on a retry.
          retryable: response.status >= 500,
        },
      };
    } catch (error) {
      // Never reached the server: DNS, TLS, an aborted timeout, a cable. Always retryable —
      // the sale is on disk and nothing has been lost.
      return {
        ok: false,
        failure: {
          error: 'NETWORK',
          detail: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Exchanges a typed activation code for this terminal's long-lived secret. */
  activate(input: {
    code: string;
    installId: string;
    platform?: string;
    appVersion?: string;
  }): Promise<ApiResult<DeviceSession>> {
    return this.post<DeviceSession>('/api/device/activate', input);
  }

  catalogue(input: {
    deviceId: string;
    deviceSecret: string;
    since?: string | null;
  }): Promise<ApiResult<unknown>> {
    return this.post('/api/device/catalogue', input);
  }

  /**
   * Sends one queued sale.
   *
   * The mapping from HTTP to `SyncOutcome` is the whole point of this method: it is what
   * decides whether a sale is retried, parked for a human, or abandoned.
   */
  async submitSale(
    credential: { deviceId: string; deviceSecret: string },
    payload: Record<string, unknown>,
  ): Promise<SyncOutcome> {
    const result = await this.post<{
      saleId: string;
      replayed: boolean;
      hadConflict: boolean;
      conflictId: string | null;
    }>('/api/device/sync', { ...credential, ...payload });

    if (result.ok) {
      const { saleId, replayed, hadConflict, conflictId } = result.value;
      // A sale can be *recorded* and still conflict: two terminals sold the same last unit
      // while offline. Both took money, so neither sale is discarded — the second is
      // flagged for a human to decide. Reporting it as plainly accepted would hide the
      // discrepancy until someone counted the shelf.
      if (hadConflict) {
        return {
          kind: 'conflict',
          conflictId,
          detail: 'The sale was recorded but disagrees with the server’s stock.',
        };
      }
      return { kind: 'accepted', remoteId: saleId, replayed };
    }

    const { error, detail } = result.failure;
    if (FATAL.has(error)) return { kind: 'unauthorized', code: error, detail };

    // Everything else is reported as retryable, including a payload the server will never
    // accept — a withdrawn product, a price that no longer exists.
    //
    // That is deliberate rather than lazy: the engine gives up after `maxAttempts` and
    // marks the operation ABANDONED, which is exactly where it belongs. An abandoned sale
    // is kept, surfaced by `needingAttention()`, and settled by a person. The alternative —
    // discarding it as unacceptable — would be Carl deciding on its own that a sale which
    // really happened, and for which money was really taken, did not.
    return { kind: 'retryable', code: error, detail };
  }
}
