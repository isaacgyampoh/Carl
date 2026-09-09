/**
 * An in-memory `SyncQueue`.
 *
 * This is the reference implementation. It defines what the SQLite and IndexedDB queues
 * must do, and the engine's test suite runs against it — so the state machine is tested
 * once, thoroughly, without a database in the way.
 *
 * It is not durable and is not for production: a crash loses the queue, and losing the
 * queue loses sales.
 */

import { type QueuedOperation, SyncState, type SyncQueue } from './ports';

type EnqueueInput = Omit<
  QueuedOperation,
  | 'state'
  | 'attempts'
  | 'lastAttemptAt'
  | 'nextAttemptAt'
  | 'lastError'
  | 'lastErrorCode'
  | 'remoteId'
  | 'conflictId'
>;

export class InMemorySyncQueue implements SyncQueue {
  private readonly rows = new Map<string, QueuedOperation>();

  enqueue(operation: EnqueueInput): Promise<void> {
    // Re-enqueueing an id is ignored rather than treated as an error. A terminal that
    // crashes between writing a sale locally and marking it queued will retry, and the
    // second attempt must not create a duplicate.
    if (!this.rows.has(operation.id)) {
      this.rows.set(operation.id, {
        ...operation,
        state: SyncState.PENDING,
        attempts: 0,
        lastAttemptAt: null,
        nextAttemptAt: null,
        lastError: null,
        lastErrorCode: null,
        remoteId: null,
        conflictId: null,
      });
    }
    return Promise.resolve();
  }

  claimBatch(limit: number, now: Date): Promise<QueuedOperation[]> {
    const ready = [...this.rows.values()]
      .filter(
        (row) =>
          (row.state === SyncState.PENDING || row.state === SyncState.FAILED) &&
          (row.nextAttemptAt === null || new Date(row.nextAttemptAt) <= now),
      )
      // Oldest first, by when the transaction actually happened. Sales apply against a
      // running stock balance, so order is part of correctness rather than tidiness.
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id))
      .slice(0, limit);

    return Promise.resolve(ready);
  }

  markInFlight(id: string, now: Date): Promise<void> {
    this.patch(id, (row) => ({
      ...row,
      state: SyncState.IN_FLIGHT,
      attempts: row.attempts + 1,
      lastAttemptAt: now.toISOString(),
    }));
    return Promise.resolve();
  }

  markSynced(id: string, remoteId: string, now: Date): Promise<void> {
    this.patch(id, (row) => ({
      ...row,
      state: SyncState.SYNCED,
      remoteId,
      lastError: null,
      lastErrorCode: null,
      nextAttemptAt: null,
      lastAttemptAt: now.toISOString(),
    }));
    return Promise.resolve();
  }

  markConflict(id: string, conflictId: string | null, detail: string, now: Date): Promise<void> {
    this.patch(id, (row) => ({
      ...row,
      state: SyncState.CONFLICT,
      conflictId,
      lastError: detail,
      // Deliberately null: a conflict is never retried automatically.
      nextAttemptAt: null,
      lastAttemptAt: now.toISOString(),
    }));
    return Promise.resolve();
  }

  markFailed(
    id: string,
    code: string | null,
    detail: string,
    retryAt: Date | null,
    now: Date,
  ): Promise<void> {
    this.patch(id, (row) => ({
      ...row,
      state: SyncState.FAILED,
      lastError: detail,
      lastErrorCode: code,
      nextAttemptAt: retryAt?.toISOString() ?? null,
      lastAttemptAt: now.toISOString(),
    }));
    return Promise.resolve();
  }

  markAbandoned(id: string, detail: string, now: Date): Promise<void> {
    this.patch(id, (row) => ({
      ...row,
      state: SyncState.ABANDONED,
      lastError: detail,
      nextAttemptAt: null,
      lastAttemptAt: now.toISOString(),
    }));
    return Promise.resolve();
  }

  counts(): Promise<Readonly<Record<SyncState, number>>> {
    const counts: Record<SyncState, number> = {
      [SyncState.PENDING]: 0,
      [SyncState.IN_FLIGHT]: 0,
      [SyncState.SYNCED]: 0,
      [SyncState.CONFLICT]: 0,
      [SyncState.FAILED]: 0,
      [SyncState.ABANDONED]: 0,
    };
    for (const row of this.rows.values()) counts[row.state] += 1;
    return Promise.resolve(counts);
  }

  needingAttention(): Promise<QueuedOperation[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (row) => row.state === SyncState.CONFLICT || row.state === SyncState.ABANDONED,
      ),
    );
  }

  /** Test helper: the full queue, in insertion order. */
  all(): QueuedOperation[] {
    return [...this.rows.values()];
  }

  get(id: string): QueuedOperation | undefined {
    return this.rows.get(id);
  }

  private patch(id: string, update: (row: QueuedOperation) => QueuedOperation): void {
    const row = this.rows.get(id);
    if (!row) throw new Error(`Unknown queued operation: ${id}`);
    this.rows.set(id, update(row));
  }
}
