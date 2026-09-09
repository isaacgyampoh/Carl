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
    // `load` also runs the registered migrations, so the schema exists after this line.
    const connection = new TauriSqliteConnection(await Database.load(path));

    /*
     * The PRAGMAs, applied here rather than in the schema file.
     *
     * They cannot live in `schema.sql`: that file is applied as a migration, migrations run
     * inside a transaction, and `journal_mode = WAL` cannot be set inside one — it fails the
     * migration and leaves the terminal with no schema at all.
     *
     * `synchronous = FULL` is the expensive one and it is deliberate. A sale must be
     * genuinely on disk before the receipt prints; the alternative trades a shop's takings
     * for a few milliseconds.
     */
    await connection.execute('pragma journal_mode = WAL');
    await connection.execute('pragma synchronous = FULL');
    await connection.execute('pragma foreign_keys = ON');
    return connection;
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
