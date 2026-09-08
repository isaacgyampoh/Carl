import { describe, expect, it } from 'vitest';
import { createTestDatabase, migrationFiles } from '../support/test-database.js';

/**
 * Every migration must apply cleanly to an empty database, in order.
 *
 * This is the cheapest test in the suite and catches the most expensive class of mistake:
 * a migration that works against the developer's already-migrated database but fails on a
 * fresh one, which is exactly what production is.
 */
describe('migrations', () => {
  it('apply in order to a clean database', async () => {
    const files = await migrationFiles();
    expect(files.length, 'expected at least one migration').toBeGreaterThan(0);

    const db = await createTestDatabase();
    try {
      const { rows } = await db.query<{ n: number }>(
        `select count(*)::int as n from pg_tables where schemaname = 'public'`,
      );
      expect(rows[0]!.n).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });

  it('are named so that lexical order is chronological order', async () => {
    const files = await migrationFiles();
    for (const file of files) {
      expect(file, `${file} must start with a 14-digit timestamp`).toMatch(
        /^\d{14}_[a-z0-9_]+\.sql$/,
      );
    }
    expect([...files].sort()).toEqual(files);
  });
});
