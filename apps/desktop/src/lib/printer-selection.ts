/**
 * Which printer this till uses.
 *
 * Held in memory and backed by `local_settings`, so the choice survives a restart and is
 * per-machine — the right scope, because the printer is a property of the counter, not of
 * the business or the cashier.
 *
 * The in-memory copy exists so the printer adapter can read the name synchronously on
 * every sale. Reading SQLite in the middle of taking money to find out where to send a
 * receipt would be a database round trip in the one code path that must not acquire new
 * ways to fail.
 */

import type { SqliteConnection } from '@carl/sync';

const KEY = 'receipt_printer_name';

let current = '';

/** The selected printer, or an empty string when none is set. */
export function selectedPrinterName(): string {
  return current;
}

/** Loads the stored selection at startup. Absent is an ordinary state, not an error. */
export async function loadPrinterSelection(db: SqliteConnection): Promise<string> {
  try {
    const rows = await db.select<{ value: string }>(
      'select value from local_settings where key = ?',
      [KEY],
    );
    current = rows[0]?.value ?? '';
  } catch {
    current = '';
  }
  return current;
}

/** Records the operator's choice, in memory and on disk. */
export async function setPrinterSelection(db: SqliteConnection, name: string): Promise<void> {
  current = name;
  await db.execute(
    `insert into local_settings (key, value) values (?, ?)
     on conflict (key) do update set value = excluded.value`,
    [KEY, name],
  );
}
