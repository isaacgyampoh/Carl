/**
 * A durable `SyncQueue` backed by SQLite.
 *
 * This is the implementation that actually holds a shop's money. `InMemorySyncQueue`
 * defines the contract and the engine's tests exercise the state machine against it; this
 * one satisfies the same contract with rows that survive a crash, a reboot, and a laptop
 * running out of battery mid-sale.
 *
 * ## Why not IndexedDB
 *
 * A browser may evict IndexedDB without warning under storage pressure. "The browser
 * cleared your unsynced sales" is not a sentence a shop should ever hear. SQLite on disk
 * is not evictable.
 *
 * ## The database handle
 *
 * Deliberately abstracted behind `SqliteConnection` rather than importing Tauri's SQL
 * plugin directly. That keeps this file testable with an ordinary SQLite driver in Node,
 * which is how the tests below run — the alternative is a queue that can only be exercised
 * inside a compiled desktop binary, which in practice means never.
 */

import { type QueuedOperation, SyncState, type SyncQueue } from '../ports';

/** The minimum a SQLite driver must provide. Tauri's plugin and node:sqlite both fit. */
export interface SqliteConnection {
  execute(sql: string, params?: readonly unknown[]): Promise<void>;
  select<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

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

interface Row {
  id: string;
  operation: string;
  payload: string;
  state: string;
  occurred_at: string;
  attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
  last_error_code: string | null;
  remote_id: string | null;
  conflict_id: string | null;
}

function toOperation(row: Row): QueuedOperation {
  return {
    id: row.id,
    operation: row.operation as QueuedOperation['operation'],
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    state: row.state as SyncState,
    occurredAt: row.occurred_at,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    lastErrorCode: row.last_error_code,
    remoteId: row.remote_id,
    conflictId: row.conflict_id,
  };
}

export class SqliteSyncQueue implements SyncQueue {
  constructor(private readonly db: SqliteConnection) {}

  /**
   * Creates the queue table.
   *
   * Idempotent, because a terminal that has been offline for weeks runs this on every
   * start and must not lose what is already queued.
   */
  async migrate(): Promise<void> {
    await this.db.execute(`
      create table if not exists sync_queue (
        id              text primary key,
        operation       text not null,
        payload         text not null,
        state           text not null default 'PENDING'
                          check (state in ('PENDING','IN_FLIGHT','SYNCED','CONFLICT','FAILED','ABANDONED')),
        occurred_at     text not null,
        attempts        integer not null default 0,
        last_attempt_at text,
        next_attempt_at text,
        last_error      text,
        last_error_code text,
        remote_id       text,
        conflict_id     text,
        created_at      text not null default (datetime('now'))
      )
    `);

    // The engine's claim query: what is ready, oldest sale first.
    await this.db.execute(`
      create index if not exists sync_queue_ready_idx
        on sync_queue (occurred_at)
        where state in ('PENDING', 'FAILED')
    `);

    // The "needs a human" view.
    await this.db.execute(`
      create index if not exists sync_queue_attention_idx
        on sync_queue (state)
        where state in ('CONFLICT', 'ABANDONED')
    `);
  }

  /**
   * Adds an operation.
   *
   * `on conflict do nothing`, not an error: a terminal that crashes between writing a sale
   * and marking it queued will retry the enqueue on restart, and that must not create a
   * duplicate or throw.
   */
  async enqueue(operation: EnqueueInput): Promise<void> {
    await this.db.execute(
      `insert into sync_queue (id, operation, payload, occurred_at, state, attempts)
       values (?, ?, ?, ?, 'PENDING', 0)
       on conflict (id) do nothing`,
      [operation.id, operation.operation, JSON.stringify(operation.payload), operation.occurredAt],
    );
  }

  async claimBatch(limit: number, now: Date): Promise<QueuedOperation[]> {
    const rows = await this.db.select<Row>(
      `select * from sync_queue
        where state in ('PENDING', 'FAILED')
          and (next_attempt_at is null or next_attempt_at <= ?)
        order by occurred_at, id
        limit ?`,
      [now.toISOString(), limit],
    );
    return rows.map(toOperation);
  }

  async markInFlight(id: string, now: Date): Promise<void> {
    await this.db.execute(
      `update sync_queue
          set state = 'IN_FLIGHT', attempts = attempts + 1, last_attempt_at = ?
        where id = ?`,
      [now.toISOString(), id],
    );
  }

  async markSynced(id: string, remoteId: string, now: Date): Promise<void> {
    await this.db.execute(
      `update sync_queue
          set state = 'SYNCED', remote_id = ?, last_error = null, last_error_code = null,
              next_attempt_at = null, last_attempt_at = ?
        where id = ?`,
      [remoteId, now.toISOString(), id],
    );
  }

  async markConflict(
    id: string,
    conflictId: string | null,
    detail: string,
    now: Date,
  ): Promise<void> {
    await this.db.execute(
      // next_attempt_at stays null: a conflict is never retried automatically, because
      // retrying cannot change a business decision the server declined to make.
      `update sync_queue
          set state = 'CONFLICT', conflict_id = ?, last_error = ?,
              next_attempt_at = null, last_attempt_at = ?
        where id = ?`,
      [conflictId, detail, now.toISOString(), id],
    );
  }

  async markFailed(
    id: string,
    code: string | null,
    detail: string,
    retryAt: Date | null,
    now: Date,
  ): Promise<void> {
    await this.db.execute(
      `update sync_queue
          set state = 'FAILED', last_error = ?, last_error_code = ?,
              next_attempt_at = ?, last_attempt_at = ?
        where id = ?`,
      [detail, code, retryAt?.toISOString() ?? null, now.toISOString(), id],
    );
  }

  async markAbandoned(id: string, detail: string, now: Date): Promise<void> {
    await this.db.execute(
      // Abandoned means set aside, never deleted. The sale happened.
      `update sync_queue
          set state = 'ABANDONED', last_error = ?, next_attempt_at = null, last_attempt_at = ?
        where id = ?`,
      [detail, now.toISOString(), id],
    );
  }

  async counts(): Promise<Readonly<Record<SyncState, number>>> {
    const rows = await this.db.select<{ state: string; n: number }>(
      `select state, count(*) as n from sync_queue group by state`,
    );
    const counts: Record<SyncState, number> = {
      [SyncState.PENDING]: 0,
      [SyncState.IN_FLIGHT]: 0,
      [SyncState.SYNCED]: 0,
      [SyncState.CONFLICT]: 0,
      [SyncState.FAILED]: 0,
      [SyncState.ABANDONED]: 0,
    };
    for (const row of rows) {
      if (row.state in counts) counts[row.state as SyncState] = Number(row.n);
    }
    return counts;
  }

  async needingAttention(): Promise<QueuedOperation[]> {
    const rows = await this.db.select<Row>(
      `select * from sync_queue where state in ('CONFLICT', 'ABANDONED') order by occurred_at`,
    );
    return rows.map(toOperation);
  }

  /**
   * Removes operations the server has confirmed, older than the retention window.
   *
   * Only SYNCED rows are ever removed, and only after long enough that no plausible
   * question about them remains. Nothing in CONFLICT or ABANDONED is touched: those are
   * the ones a person still has to deal with.
   */
  async prune(before: Date): Promise<number> {
    const [row] = await this.db.select<{ n: number }>(
      `select count(*) as n from sync_queue where state = 'SYNCED' and last_attempt_at < ?`,
      [before.toISOString()],
    );
    await this.db.execute(
      `delete from sync_queue where state = 'SYNCED' and last_attempt_at < ?`,
      [before.toISOString()],
    );
    return Number(row?.n ?? 0);
  }

  /** Everything in the queue. For the terminal's own status view. */
  async all(): Promise<QueuedOperation[]> {
    const rows = await this.db.select<Row>(`select * from sync_queue order by occurred_at`);
    return rows.map(toOperation);
  }

  async get(id: string): Promise<QueuedOperation | undefined> {
    const rows = await this.db.select<Row>(`select * from sync_queue where id = ?`, [id]);
    return rows[0] ? toOperation(rows[0]) : undefined;
  }
}
