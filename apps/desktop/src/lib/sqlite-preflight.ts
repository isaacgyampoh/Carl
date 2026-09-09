/**
 * Proves the local database works before the till is allowed to open.
 *
 * ## Why a POS checks this at startup
 *
 * Carl's central promise is that a sale is written to disk before the cashier is told it
 * succeeded. If SQLite is not actually working, that promise is silently void: the terminal
 * looks fine, takes money, prints receipts, and loses every transaction. A till that cannot
 * write must refuse to open — that is strictly better than one that takes money it cannot
 * record.
 *
 * This is not a theoretical risk. A release build once shipped a frontend in which the SQL
 * plugin had never been bundled, and the first sign of it was a module-resolution error at
 * runtime. Nothing before this point — not the type checker, not the tests, not the Tauri
 * build — had noticed.
 *
 * ## What it checks, in order
 *
 *   1. The plugin answers at all.
 *   2. The schema is present.
 *   3. A row can be written, read back identically, and removed.
 *   4. Data written by previous runs is still there.
 *
 * (4) is the only one that proves *persistence* rather than a working in-memory database,
 * and it is checked with the boot counter rather than a test record: an ordinary value the
 * terminal has a reason to keep, so nothing diagnostic is left in the production database.
 */

import type { SqliteConnection } from '@carl/sync';

export interface PreflightResult {
  readonly ok: boolean;
  readonly checks: readonly { readonly name: string; readonly ok: boolean }[];
  /** How many times this terminal has started. Above 1 proves data survives a restart. */
  readonly bootCount: number;
  readonly detail?: string;
}

const PROBE_KEY = '__preflight_probe';
const BOOT_KEY = 'boot_count';

export async function verifyLocalDatabase(db: SqliteConnection): Promise<PreflightResult> {
  const checks: { name: string; ok: boolean }[] = [];
  const record = (name: string, ok: boolean) => {
    checks.push({ name, ok });
    return ok;
  };

  try {
    // 1. The plugin responds. This is the check that fails when the SQL plugin was never
    //    bundled into the frontend, or the Rust side never registered it.
    const answered = await db.select<{ answer: number }>('select 1 as answer');
    if (!record('the database responds', answered[0]?.answer === 1)) {
      return { ok: false, checks, bootCount: 0, detail: 'The SQLite plugin did not respond.' };
    }

    // 2. The schema is present. A fresh file with no tables means migrations never ran.
    const tables = await db.select<{ name: string }>(
      `select name from sqlite_master where type = 'table' and name in
         ('local_settings', 'sync_queue', 'products', 'device_config')`,
    );
    if (!record('the schema is present', tables.length === 4)) {
      return {
        ok: false,
        checks,
        bootCount: 0,
        detail: `Expected 4 core tables, found ${tables.length}.`,
      };
    }

    // 3. A full write / read / delete round trip. Reading back a value that is not what was
    //    written is worse than not writing at all, so the comparison is exact.
    const witness = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await db.execute(
      `insert into local_settings (key, value) values (?, ?)
       on conflict (key) do update set value = excluded.value`,
      [PROBE_KEY, witness],
    );
    const readBack = await db.select<{ value: string }>(
      'select value from local_settings where key = ?',
      [PROBE_KEY],
    );
    const roundTripped = readBack[0]?.value === witness;
    // Removed whether or not it matched: nothing diagnostic is left behind in a production
    // database, which is the whole reason this uses a dedicated key.
    await db.execute('delete from local_settings where key = ?', [PROBE_KEY]);

    if (!record('a row can be written and read back exactly', roundTripped)) {
      return {
        ok: false,
        checks,
        bootCount: 0,
        detail: 'A value read back from SQLite did not match what was written.',
      };
    }

    // 4. Persistence across restarts. The counter is real state the terminal keeps, not a
    //    test artefact, so it proves the property without polluting anything.
    const previous = await db.select<{ value: string }>(
      'select value from local_settings where key = ?',
      [BOOT_KEY],
    );
    const bootCount = Number(previous[0]?.value ?? '0') + 1;
    await db.execute(
      `insert into local_settings (key, value) values (?, ?)
       on conflict (key) do update set value = excluded.value`,
      [BOOT_KEY, String(bootCount)],
    );
    // True from the second start onwards. On a genuinely first run there is nothing earlier
    // to have survived, so this is reported rather than failed.
    record('data written by earlier runs survived', bootCount > 1);

    return { ok: true, checks, bootCount };
  } catch (error) {
    return {
      ok: false,
      checks,
      bootCount: 0,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
