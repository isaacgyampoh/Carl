/**
 * The real-PostgreSQL driver for Carl's database test suite.
 *
 * ## Why this exists alongside PGlite
 *
 * PGlite runs the same PostgreSQL engine in WebAssembly and catches the overwhelming
 * majority of problems, but it cannot do two things that matter:
 *
 *   1. **Concurrency.** It is an embedded single-connection engine, so two terminals
 *      contending for the same stock row cannot be expressed at all.
 *   2. **Supabase itself.** The `auth` schema, the API roles and the extension layout are
 *      recreated by a shim locally. A shim is a model of the real thing, and a model can
 *      be wrong.
 *
 * This driver runs the identical suite against a real Supabase project. The assertions do
 * not change; only where they run does.
 *
 * ## Connection
 *
 * Reads `SUPABASE_DB_URL`. Use the **session-mode pooler** (port 5432) rather than
 * transaction mode (6543): the suite relies on `SET ROLE` and explicit transactions
 * persisting across statements, and transaction-mode pooling hands each statement to a
 * different backend.
 *
 * ## Safety
 *
 * `reset()` truncates every application table. That is correct for a disposable
 * verification project and catastrophic anywhere else, so the driver refuses to start
 * unless `CARL_ALLOW_DESTRUCTIVE_DB_TESTS=yes` is set explicitly. There is no default that
 * lets a mistyped connection string wipe real data.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import type { QueryResult, TestDatabase } from './test-database.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', 'supabase', 'migrations');

/**
 * Reference data the migrations seed. `reset()` must leave it alone — truncating it makes
 * `provision_tenant()` find no role templates, which surfaces much later as a baffling
 * cross-tenant error from an integrity trigger.
 */
const SEEDED_REFERENCE_TABLES = [
  'permissions',
  'role_templates',
  'role_template_permissions',
  // `subscription_plans` is deliberately NOT preserved. Only permissions and role
  // templates are needed by provision_tenant(); plans are ordinary data that tests insert,
  // and preserving them made a second run collide on the unique key against a persistent
  // database.
] as const;

class PgTestDatabase implements TestDatabase {
  readonly supportsConcurrency = true;

  constructor(
    private readonly client: pg.Client,
    private readonly connectionString: string,
  ) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    const result = await this.client.query(sql, params as unknown[]);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  private async withIdentity<T>(
    role: string,
    claims: Record<string, unknown> | null,
    fn: () => Promise<T>,
  ): Promise<T> {
    await this.client.query(`select set_config('request.jwt.claims', $1, false)`, [
      claims === null ? '' : JSON.stringify(claims),
    ]);
    await this.client.query(`set role ${role}`);
    try {
      return await fn();
    } finally {
      // Restored even when the body throws, so one failing test cannot leave the
      // connection impersonating someone else for every test after it.
      await this.client.query('reset role');
      await this.client.query(`select set_config('request.jwt.claims', '', false)`);
    }
  }

  asUser<T>(
    userId: string,
    fn: () => Promise<T>,
    claims: Record<string, unknown> = {},
  ): Promise<T> {
    return this.withIdentity(
      'authenticated',
      { sub: userId, role: 'authenticated', aud: 'authenticated', ...claims },
      fn,
    );
  }

  asAnon<T>(fn: () => Promise<T>): Promise<T> {
    return this.withIdentity('anon', { role: 'anon' }, fn);
  }

  asServiceRole<T>(fn: () => Promise<T>): Promise<T> {
    return this.withIdentity('service_role', { role: 'service_role' }, fn);
  }

  async asAdmin<T>(fn: () => Promise<T>): Promise<T> {
    const { rows } = await this.query<{ role: string }>('select current_user as role');
    const previous = rows[0]?.role;
    await this.client.query('reset role');
    try {
      return await fn();
    } finally {
      if (previous && previous !== 'postgres') {
        await this.client.query(`set role ${previous}`);
      }
    }
  }

  async expectDenied(sql: string, params: readonly unknown[] = []): Promise<void> {
    try {
      await this.query(sql, params);
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      if (code === '42501' || /row-level security|permission denied/i.test(message)) {
        // A failed statement aborts the surrounding transaction if one is open; the
        // caller's `finally` will reset the role, which would itself fail. Clear it here.
        await this.client.query('rollback').catch(() => undefined);
        return;
      }
      throw new Error(
        `Statement failed, but not because it was denied. This test is not proving what it ` +
          `claims to prove.\n  SQL: ${sql}\n  Error (${code ?? 'no code'}): ${message}`,
        { cause: error },
      );
    }
    throw new Error(`Expected the statement to be denied, but it succeeded.\n  SQL: ${sql}`);
  }

  async expectNoRowsAffected(sql: string, params: readonly unknown[] = []): Promise<void> {
    const trimmed = sql.trim();
    if (!/returning/i.test(trimmed)) {
      throw new Error(
        'expectNoRowsAffected needs a RETURNING clause to count what the statement changed.',
      );
    }
    const { rows } = await this.query(trimmed, params);
    if (rows.length > 0) {
      throw new Error(
        `Expected the statement to change nothing, but it changed ${rows.length} row(s).\n  SQL: ${sql}`,
      );
    }
  }

  /** A second, independent session against the same database. This is the point of this driver. */
  async concurrent(): Promise<TestDatabase> {
    const client = new pg.Client({
      connectionString: this.connectionString,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    return new PgTestDatabase(client, this.connectionString);
  }

  /**
   * Empties the application tables between tests.
   *
   * Only tables that actually hold rows are truncated. This is not a micro-optimisation:
   * an earlier version truncated all fifty tables before every test, and across a few
   * hundred tests that is sixteen thousand TRUNCATEs. Each one allocates a new relfilenode
   * and churns the system catalogue, which bloated `pg_class` to twelve times its size and
   * filled the project's disk mid-run — the suite failed with "No space left on device"
   * against a database holding 18 MB of data.
   *
   * Most tests touch five or six tables. Checking emptiness first costs almost nothing,
   * because the tables being checked are empty.
   */
  async reset(): Promise<void> {
    await this.client.query('reset role').catch(() => undefined);
    // A DO block is not a prepared statement and cannot take bind parameters, so the
    // preserved-table list is inlined. These are compile-time constants in this file, not
    // caller input, and each is quoted as a literal regardless.
    const preserved = SEEDED_REFERENCE_TABLES.map((t) => `'${t}'`).join(', ');

    await this.client.query(
      `do $$
       declare
         r         record;
         populated text[] := array[]::text[];
         has_rows  boolean;
       begin
         for r in
           select c.relname
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r'
             and c.relname <> all(array[${preserved}]::text[])
         loop
           execute format('select exists (select 1 from public.%I limit 1)', r.relname) into has_rows;
           if has_rows then
             populated := populated || format('public.%I', r.relname);
           end if;
         end loop;

         if array_length(populated, 1) > 0 then
           execute 'truncate table ' || array_to_string(populated, ', ') || ' cascade';
         end if;

         if exists (select 1 from auth.users limit 1) then
           truncate table auth.users cascade;
         end if;
       end
       $$`,
    );
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

export interface PgDriverOptions {
  /** Re-apply migrations before running. Off by default: the project is already migrated. */
  readonly applyMigrations?: boolean;
}

export async function createPgTestDatabase(options: PgDriverOptions = {}): Promise<TestDatabase> {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error(
      'SUPABASE_DB_URL is required for CARL_TEST_DB_DRIVER=pg.\n' +
        'Use the session-mode pooler connection string (port 5432), not transaction mode.',
    );
  }

  // The suite truncates every application table. Requiring an explicit opt-in means a
  // mistyped connection string cannot quietly destroy a real database.
  if (process.env.CARL_ALLOW_DESTRUCTIVE_DB_TESTS !== 'yes') {
    throw new Error(
      'Refusing to run destructive database tests.\n' +
        'This suite TRUNCATES every application table. Point SUPABASE_DB_URL at a disposable\n' +
        'verification project and set CARL_ALLOW_DESTRUCTIVE_DB_TESTS=yes to confirm.',
    );
  }

  const client = new pg.Client({
    connectionString,
    // Supabase terminates TLS at the pooler with a certificate chain Node does not carry
    // by default. The connection is still encrypted; only chain verification is relaxed.
    ssl: { rejectUnauthorized: false },
    // A hung connection should fail the suite quickly rather than sit until the hook
    // timeout, which makes the cause much harder to see.
    connectionTimeoutMillis: 15_000,
    statement_timeout: 60_000,
  });

  await client.connect();
  const db = new PgTestDatabase(client, connectionString);

  if (options.applyMigrations) {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query(sql);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${file} failed to apply:\n  ${message}`, { cause: error });
      }
    }
  }

  await db.reset();
  return db;
}
