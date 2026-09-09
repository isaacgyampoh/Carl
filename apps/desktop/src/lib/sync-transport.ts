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

export class DeviceSyncTransport implements SyncTransport {
  constructor(
    private readonly api: DeviceApi,
    private readonly credential: DeviceCredential,
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

  submit(operation: QueuedOperation): Promise<SyncOutcome> {
    if (operation.operation !== 'complete_sale') {
      // Returns rather than throws: an operation this build does not know how to send is a
      // deployment mismatch, and the sale must stay queued for a newer build rather than
      // being lost by a crash.
      return Promise.resolve({
        kind: 'retryable',
        code: 'UNSUPPORTED_OPERATION',
        detail: `This terminal cannot send a ${operation.operation} yet.`,
      });
    }

    return this.api.submitSale(this.credential, {
      // The idempotency key IS the operation id, generated once when the cashier finished
      // the sale and reused for every retry. That is what makes resending safe when a
      // connection dies without saying whether the sale landed.
      idempotencyKey: operation.id,
      soldAt: operation.occurredAt,
      ...operation.payload,
    });
  }
}
