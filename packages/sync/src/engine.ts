/**
 * The sync engine.
 *
 * Drains the local queue to the server when connectivity allows. Its contract is short and
 * absolute:
 *
 *   **No queued transaction is ever silently discarded.**
 *
 * Every operation ends up accepted, raised as a conflict for a human, or set aside as
 * abandoned — and abandoned still means kept. A sale that cannot be synced still happened:
 * the customer paid and left with the goods, and deleting the row does not undo that.
 *
 * ## Why it is sequential
 *
 * Sales apply against a running stock balance, so replaying them out of order produces a
 * different sequence of ledger balances than actually occurred. Submitting concurrently
 * would be faster and wrong.
 *
 * ## Why a conflict is never retried
 *
 * A conflict is a business decision the server declined to make — stock did not cover the
 * sale, a product was withdrawn. Retrying cannot change that, and retrying forever turns a
 * queue into a loop. It goes to a person.
 */

import { type Clock, createLogger, type Logger } from '@carl/shared';

import { nextAttemptAt } from './backoff';
import {
  type QueuedOperation,
  SyncState,
  type SyncEngineOptions,
  type SyncProgress,
  type SyncQueue,
  type SyncTransport,
} from './ports';

export const DEFAULT_BATCH_SIZE = 25;
export const DEFAULT_MAX_ATTEMPTS = 8;

export type SyncRunResult =
  | { readonly status: 'idle'; readonly reason: 'offline' | 'empty' }
  | { readonly status: 'completed'; readonly progress: SyncProgress }
  /** The terminal is no longer allowed to sync. The run stopped and must not resume. */
  | {
      readonly status: 'halted';
      readonly code: string;
      readonly detail: string;
      readonly progress: SyncProgress;
    };

export class SyncEngine {
  private readonly queue: SyncQueue;
  private readonly transport: SyncTransport;
  private readonly clock: Clock;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly onProgress: ((progress: SyncProgress) => void) | undefined;
  private readonly log: Logger;

  /**
   * Guards against two runs overlapping.
   *
   * A reconnect event and the periodic timer can fire together. Two concurrent runs would
   * both claim the same operations and submit them twice — harmless, because every write
   * is idempotent, but it wastes a poor connection and makes the progress figures wrong.
   */
  private running = false;

  constructor(options: SyncEngineOptions, logger?: Logger) {
    this.queue = options.queue;
    this.transport = options.transport;
    this.clock = options.clock;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.onProgress = options.onProgress;
    this.log = logger ?? createLogger({ level: 'info', base: { module: 'sync-engine' } });
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Drains the queue once.
   *
   * Safe to call whenever connectivity might have returned. Calling it while a run is in
   * progress is a no-op rather than an error.
   */
  async run(): Promise<SyncRunResult> {
    if (this.running) {
      return { status: 'idle', reason: 'empty' };
    }
    if (!this.transport.isOnline()) {
      return { status: 'idle', reason: 'offline' };
    }

    this.running = true;
    const progress = { attempted: 0, accepted: 0, conflicted: 0, failed: 0, remaining: 0 };

    try {
      const batch = await this.queue.claimBatch(this.batchSize, this.clock.now());
      if (batch.length === 0) {
        return { status: 'idle', reason: 'empty' };
      }

      for (const operation of batch) {
        // Connectivity can drop mid-batch. Stopping leaves the rest PENDING for the next
        // run rather than burning an attempt on each of them.
        if (!this.transport.isOnline()) break;

        const outcome = await this.attempt(operation, progress);
        if (outcome === 'halt') {
          const counts = await this.queue.counts();
          return {
            status: 'halted',
            code: this.haltCode ?? 'UNAUTHORIZED',
            detail: this.haltDetail ?? 'This terminal may no longer synchronise.',
            progress: { ...progress, remaining: counts[SyncState.PENDING] },
          };
        }
      }

      const counts = await this.queue.counts();
      const result: SyncProgress = { ...progress, remaining: counts[SyncState.PENDING] };
      this.onProgress?.(result);
      return { status: 'completed', progress: result };
    } finally {
      this.running = false;
    }
  }

  private haltCode: string | null = null;
  private haltDetail: string | null = null;

  private async attempt(
    operation: QueuedOperation,
    progress: { attempted: number; accepted: number; conflicted: number; failed: number },
  ): Promise<'continue' | 'halt'> {
    const now = this.clock.now();
    progress.attempted += 1;

    await this.queue.markInFlight(operation.id, now);

    let outcome;
    try {
      outcome = await this.transport.submit(operation);
    } catch (error) {
      // A thrown transport error is a network failure, not a server verdict. Treated as
      // retryable: the operation may well have reached the server, and the idempotency key
      // makes re-sending it safe.
      const detail = error instanceof Error ? error.message : String(error);
      outcome = { kind: 'retryable' as const, code: null, detail };
    }

    switch (outcome.kind) {
      case 'accepted':
        await this.queue.markSynced(operation.id, outcome.remoteId, now);
        progress.accepted += 1;
        this.log.debug('operation synced', {
          operationId: operation.id,
          replayed: outcome.replayed,
        });
        return 'continue';

      case 'conflict':
        // Never retried. The server declined on business grounds, and a person must decide.
        await this.queue.markConflict(operation.id, outcome.conflictId, outcome.detail, now);
        progress.conflicted += 1;
        this.log.warn('operation conflicted', {
          operationId: operation.id,
          detail: outcome.detail,
        });
        return 'continue';

      case 'unauthorized':
        // Revoked terminal or suspended tenant. Nothing else in the queue can succeed
        // either, so the run stops rather than burning an attempt on every remaining item.
        this.haltCode = outcome.code;
        this.haltDetail = outcome.detail;
        await this.queue.markFailed(operation.id, outcome.code, outcome.detail, null, now);
        this.log.error('sync halted', { code: outcome.code, detail: outcome.detail });
        return 'halt';

      case 'retryable': {
        const attempts = operation.attempts + 1;
        progress.failed += 1;

        if (attempts >= this.maxAttempts) {
          // Set aside, not deleted. The sale happened.
          await this.queue.markAbandoned(
            operation.id,
            `${outcome.detail} (after ${attempts} attempts)`,
            now,
          );
          this.log.error('operation abandoned after repeated failures', {
            operationId: operation.id,
            attempts,
            detail: outcome.detail,
          });
          return 'continue';
        }

        await this.queue.markFailed(
          operation.id,
          outcome.code,
          outcome.detail,
          nextAttemptAt(attempts, now),
          now,
        );
        return 'continue';
      }
    }
  }
}
