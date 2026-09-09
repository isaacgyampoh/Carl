/**
 * What the sync engine needs from its host.
 *
 * The engine is deliberately storage-agnostic. Carl Desktop backs it with SQLite; the PWA
 * backs it with IndexedDB. Both are the same code and the same tests, because the queue's
 * correctness has nothing to do with where the rows are kept — and a second
 * implementation of "did this transaction sync" is a second thing that can be wrong.
 */

import type { Clock } from '@carl/shared';

/** How far a queued transaction has got. */
export const SyncState = {
  /** Written locally, not yet attempted. */
  PENDING: 'PENDING',
  /** An attempt is in flight. */
  IN_FLIGHT: 'IN_FLIGHT',
  /** Accepted by the server. */
  SYNCED: 'SYNCED',
  /** Rejected on business grounds and raised for a human. Never retried automatically. */
  CONFLICT: 'CONFLICT',
  /** The attempt failed. Will be retried. */
  FAILED: 'FAILED',
  /**
   * Failed too many times.
   *
   * Deliberately not deleted. A sale that cannot be synced still happened — the customer
   * paid and took the goods — so it is kept for a person to deal with.
   */
  ABANDONED: 'ABANDONED',
} as const;

export type SyncState = (typeof SyncState)[keyof typeof SyncState];

/** A transaction waiting to reach the server. */
export interface QueuedOperation {
  /** Client-generated, stable across every retry. This is what makes the write safe. */
  readonly id: string;
  readonly operation: 'complete_sale' | 'process_return' | 'apply_stock_adjustment';
  readonly payload: Readonly<Record<string, unknown>>;
  readonly state: SyncState;
  /** When the operation actually happened, not when it was queued. */
  readonly occurredAt: string;
  readonly attempts: number;
  readonly lastAttemptAt: string | null;
  /** Earliest time a retry may run. Set by the backoff schedule. */
  readonly nextAttemptAt: string | null;
  readonly lastError: string | null;
  readonly lastErrorCode: string | null;
  /** The server's identifier once accepted, so a receipt can be reprinted. */
  readonly remoteId: string | null;
  readonly conflictId: string | null;
}

/**
 * The local queue.
 *
 * Implementations must be durable: an operation is only removed from `PENDING` once the
 * server has confirmed it. Losing the queue on a crash loses sales.
 */
export interface SyncQueue {
  enqueue(
    operation: Omit<
      QueuedOperation,
      | 'state'
      | 'attempts'
      | 'lastAttemptAt'
      | 'nextAttemptAt'
      | 'lastError'
      | 'lastErrorCode'
      | 'remoteId'
      | 'conflictId'
    >,
  ): Promise<void>;

  /**
   * Operations ready to attempt, oldest first.
   *
   * Order matters. Sales are applied against a running stock balance, so replaying them
   * out of order produces a different — and wrong — sequence of ledger balances.
   */
  claimBatch(limit: number, now: Date): Promise<QueuedOperation[]>;

  markInFlight(id: string, now: Date): Promise<void>;
  markSynced(id: string, remoteId: string, now: Date): Promise<void>;
  markConflict(id: string, conflictId: string | null, detail: string, now: Date): Promise<void>;
  markFailed(
    id: string,
    code: string | null,
    detail: string,
    retryAt: Date | null,
    now: Date,
  ): Promise<void>;
  markAbandoned(id: string, detail: string, now: Date): Promise<void>;

  /** Counts by state, for the terminal's status display and the server's telemetry. */
  counts(): Promise<Readonly<Record<SyncState, number>>>;

  /** Everything needing human attention: conflicts and abandoned operations. */
  needingAttention(): Promise<QueuedOperation[]>;
}

/** What the server said about one submitted operation. */
export type SyncOutcome =
  | { readonly kind: 'accepted'; readonly remoteId: string; readonly replayed: boolean }
  | { readonly kind: 'conflict'; readonly conflictId: string | null; readonly detail: string }
  /** A transient failure: network, timeout, server error. Worth retrying. */
  | { readonly kind: 'retryable'; readonly code: string | null; readonly detail: string }
  /**
   * The terminal is no longer permitted to sync at all — revoked, or the tenant is
   * suspended. Retrying is pointless and the whole run must stop.
   */
  | { readonly kind: 'unauthorized'; readonly code: string; readonly detail: string };

/** How the engine reaches the server. */
export interface SyncTransport {
  /** Whether the host believes it currently has connectivity. */
  isOnline(): boolean;
  submit(operation: QueuedOperation): Promise<SyncOutcome>;
}

export interface SyncEngineOptions {
  readonly queue: SyncQueue;
  readonly transport: SyncTransport;
  readonly clock: Clock;
  /** Operations per run. Small enough that a run finishes on a poor connection. */
  readonly batchSize?: number;
  /** Attempts before an operation is set aside for a person. */
  readonly maxAttempts?: number;
  readonly onProgress?: (progress: SyncProgress) => void;
}

export interface SyncProgress {
  readonly attempted: number;
  readonly accepted: number;
  readonly conflicted: number;
  readonly failed: number;
  readonly remaining: number;
}
