/**
 * The bridge between the queue and the server.
 *
 * Thin on purpose: the retry policy, the attempt counting and the state transitions all
 * live in `@carl/sync`'s engine, which is shared with the web PWA and tested against both
 * an in-memory and a SQLite queue. This adds only what is specific to a desktop terminal —
 * its credential, and how the operating system reports connectivity.
 */

import type { QueuedOperation, SyncOutcome, SyncTransport } from '@carl/sync';

import type { DeviceApi } from './device-api';

export interface DeviceCredential {
  readonly deviceId: string;
  readonly deviceSecret: string;
}

/**
 * Supplies the signed-in cashier's access token.
 *
 * A function rather than a value: access tokens are short-lived, and a terminal that has
 * been offline for hours is always holding a stale one. It is resolved per attempt, when
 * the network is known to be there.
 */
export type AccessTokenSource = () => Promise<string | null>;

export class DeviceSyncTransport implements SyncTransport {
  constructor(
    private readonly api: DeviceApi,
    private readonly credential: DeviceCredential,
    private readonly accessToken: AccessTokenSource,
    /**
     * How the host reports connectivity. Injected rather than reading `navigator.onLine`
     * directly so it can be driven in tests — and because `navigator.onLine` reports
     * whether a cable is plugged in, not whether Carl is reachable.
     */
    private readonly online: () => boolean = () => globalThis.navigator?.onLine ?? true,
  ) {}

  isOnline(): boolean {
    return this.online();
  }

  async submit(operation: QueuedOperation): Promise<SyncOutcome> {
    if (operation.operation !== 'complete_sale') {
      // Returns rather than throws: an operation this build does not know how to send is a
      // deployment mismatch, and the sale must stay queued for a newer build rather than
      // being lost by a crash.
      return {
        kind: 'retryable',
        code: 'UNSUPPORTED_OPERATION',
        detail: `This terminal cannot send a ${operation.operation} yet.`,
      };
    }

    const accessToken = await this.accessToken();
    if (!accessToken) {
      // No cashier session. Retryable rather than fatal: the sale is on disk and will go
      // through as soon as someone signs in. Discarding it because nobody is signed in
      // right now would lose a sale that really happened.
      return {
        kind: 'retryable',
        code: 'NO_CASHIER_SESSION',
        detail: 'No cashier is signed in at this terminal.',
      };
    }

    return this.api.submitSale({ ...this.credential, accessToken }, {
      // The idempotency key IS the operation id, generated once when the cashier finished
      // the sale and reused for every retry. That is what makes resending safe when a
      // connection dies without saying whether the sale landed.
      idempotencyKey: operation.id,
      soldAt: operation.occurredAt,
      ...operation.payload,
    });
  }
}
