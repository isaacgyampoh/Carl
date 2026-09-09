/**
 * A `SqliteConnection` backed by Node's built-in SQLite.
 *
 * Its purpose is testing: it lets the durable queue be exercised by ordinary `pnpm test`
 * rather than only inside a compiled desktop binary. A queue that can only be tested by
 * building a Tauri app is a queue nobody tests.
 *
 * The Tauri adapter is the counterpart used in the shipped application. Both satisfy the
 * same interface, and the same test suite runs against both.
 */

import { DatabaseSync } from 'node:sqlite';

import type { SqliteConnection } from './sqlite-queue';

export class NodeSqliteConnection implements SqliteConnection {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    // Matches the desktop configuration: a sale must be on disk before its receipt prints.
    this.db.exec('pragma journal_mode = WAL');
    this.db.exec('pragma foreign_keys = ON');
  }

  // `async` deliberately: node:sqlite is synchronous, so a constraint violation would
  // otherwise escape as a synchronous throw. The interface promises a Promise, and callers
  // that `await` a write must see a rejection — not an exception thrown before the await.
  // A test asserting `rejects.toThrow` on a CHECK constraint fails without this.
  // eslint-disable-next-line @typescript-eslint/require-await -- see above
  async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
    // node:sqlite rejects `undefined`; the queue uses null for absent values throughout.
    this.db.prepare(sql).run(...(params.map((p) => p ?? null) as never[]));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- symmetry with execute()
  async select<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params.map((p) => p ?? null) as never[])) as T[];
  }

  close(): void {
    this.db.close();
  }
}
