/**
 * Durable key/value storage for the terminal.
 *
 * Deliberately SQLite rather than `localStorage`: a webview's storage can be cleared by an
 * update, a crash or a user, and the install id kept here is what makes a retried
 * activation idempotent. Losing it strands an installer with a terminal that is activated
 * on the server and holds no secret — on a shop floor, on a bad connection, which is
 * exactly when a retry is needed.
 *
 * Never used for credentials. Those live in the OS credential store.
 */

import type { SqliteConnection } from '@carl/sync';

export class LocalSettings {
  constructor(private readonly db: SqliteConnection) {}

  async get(key: string): Promise<string | null> {
    const rows = await this.db.select<{ value: string }>(
      'select value from local_settings where key = ?',
      [key],
    );
    return rows[0]?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.execute(
      `insert into local_settings (key, value) values (?, ?)
       on conflict (key) do update set value = excluded.value`,
      [key, value],
    );
  }

  /**
   * The identifier that makes a retried activation safe.
   *
   * Created once, on first run, and never changed. Retrying activation with the same
   * install id returns the same session rather than "code already consumed".
   */
  async installId(): Promise<string> {
    const existing = await this.get('install_id');
    if (existing) return existing;
    const created = crypto.randomUUID();
    await this.set('install_id', created);
    return created;
  }
}
