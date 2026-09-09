/**
 * A `SqliteConnection` backed by Tauri's SQL plugin.
 *
 * The counterpart to the Node adapter used in tests. Both satisfy the same interface, and
 * the same suites run against both — so the queue and the catalogue store are exercised by
 * ordinary `pnpm test` rather than only inside a compiled binary.
 *
 * The database file lives in the app's data directory, which is per-user and outside the
 * bundle: a terminal's sales are not in a folder an update overwrites.
 */

import Database from '@tauri-apps/plugin-sql';
import type { SqliteConnection } from '@carl/sync';

export class TauriSqliteConnection implements SqliteConnection {
  private constructor(private readonly db: Database) {}

  static async open(path = 'sqlite:carl.db'): Promise<TauriSqliteConnection> {
    return new TauriSqliteConnection(await Database.load(path));
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
    await this.db.execute(sql, params as unknown[]);
  }

  async select<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.db.select<T[]>(sql, params as unknown[]);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
