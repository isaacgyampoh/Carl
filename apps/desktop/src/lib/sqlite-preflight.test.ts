import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { NodeSqliteConnection } from '@carl/sync/sqlite/node-sqlite-adapter';

import { verifyLocalDatabase } from './sqlite-preflight';

/**
 * The startup check that decides whether the till may open.
 *
 * A terminal that cannot write to disk must refuse to trade, because Carl's central promise
 * is that a sale is recorded before the cashier is told it succeeded. These tests exist to
 * prove the check actually fails when the database is broken — a preflight that always
 * passes is worse than none, since it converts a visible failure into a silent one.
 */
describe('verifyLocalDatabase', () => {
  const SCHEMA = readFileSync(
    join(import.meta.dirname, '..', '..', 'src-tauri', 'schema.sql'),
    'utf8',
  );

  async function applySchema(connection: NodeSqliteConnection): Promise<void> {
    for (const statement of SCHEMA.split(';')) {
      if (statement.trim()) await connection.execute(statement);
    }
  }

  let connection: NodeSqliteConnection;

  beforeEach(async () => {
    connection = new NodeSqliteConnection(':memory:');
    await applySchema(connection);
  });

  it('passes on a properly initialised database', async () => {
    const result = await verifyLocalDatabase(connection);
    expect(result.ok).toBe(true);
    expect(result.checks.filter((c) => c.name !== 'data written by earlier runs survived')).toEqual(
      expect.arrayContaining([expect.objectContaining({ ok: true })]),
    );
  });

  it('leaves nothing diagnostic behind', async () => {
    await verifyLocalDatabase(connection);
    const rows = await connection.select<{ key: string }>('select key from local_settings');
    // The boot counter is real state the terminal keeps. The probe row must be gone.
    expect(rows.map((r) => r.key)).toEqual(['boot_count']);
  });

  it('fails when the schema was never applied', async () => {
    // What an empty database file looks like: the plugin works, but migrations never ran.
    const empty = new NodeSqliteConnection(':memory:');
    const result = await verifyLocalDatabase(empty);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/core tables/i);
    empty.close();
  });

  it('fails when the database cannot be reached at all', async () => {
    // Stands in for the defect that actually shipped: the SQL plugin was not bundled, so
    // every call rejected with a module-resolution error.
    const broken = {
      execute: () =>
        Promise.reject(
          new Error("Module name, '@tauri-apps/plugin-sql' does not resolve to a valid URL"),
        ),
      select: () =>
        Promise.reject(
          new Error("Module name, '@tauri-apps/plugin-sql' does not resolve to a valid URL"),
        ),
    };

    const result = await verifyLocalDatabase(broken);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/does not resolve to a valid URL/);
  });

  it('fails when a value does not read back as it was written', async () => {
    // Silent corruption. Worse than an outright failure, so it is checked exactly.
    const lying = {
      execute: (sql: string, params?: readonly unknown[]) => connection.execute(sql, params),
      select: async <T>(sql: string, params?: readonly unknown[]): Promise<T[]> => {
        const rows = await connection.select<Record<string, unknown>>(sql, params);
        if (sql.includes('value from local_settings') && rows.length > 0) {
          return [{ ...rows[0], value: 'something else entirely' }] as T[];
        }
        return rows as T[];
      },
    };

    const result = await verifyLocalDatabase(lying);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/did not match/i);
  });

  describe('persistence across restarts', () => {
    it('reports the first run as having nothing to have survived', async () => {
      const result = await verifyLocalDatabase(connection);
      expect(result.bootCount).toBe(1);
      expect(result.checks).toContainEqual({
        name: 'data written by earlier runs survived',
        ok: false,
      });
    });

    it('confirms data survived once the terminal has been restarted', async () => {
      // The only check here that distinguishes a working file from a working *in-memory*
      // database — which is exactly the failure a POS cannot afford.
      const path = `/tmp/carl-preflight-${randomUUID()}.db`;
      const first = new NodeSqliteConnection(path);
      await applySchema(first);
      expect((await verifyLocalDatabase(first)).bootCount).toBe(1);
      first.close();

      const second = new NodeSqliteConnection(path);
      const result = await verifyLocalDatabase(second);

      expect(result.ok).toBe(true);
      expect(result.bootCount).toBe(2);
      expect(result.checks).toContainEqual({
        name: 'data written by earlier runs survived',
        ok: true,
      });
      second.close();
      unlinkSync(path);
    });
  });
});
