/**
 * Carl's database test harness.
 *
 * ## Why this exists
 *
 * Carl's tenant isolation lives in PostgreSQL Row Level Security, not in TypeScript. A test
 * that mocks the database proves nothing about it. To have any value, a security test must
 * apply the real migrations to a real PostgreSQL instance and issue real queries as the real
 * `authenticated` role with a real JWT claim set.
 *
 * ## How it runs without Docker
 *
 * The default driver is PGlite — PostgreSQL 18 compiled to WebAssembly and run in-process.
 * It is genuinely PostgreSQL: the same planner, the same `plpgsql`, the same RLS enforcement.
 * That keeps the security suite runnable on any machine with Node, which matters because a
 * test suite that requires Docker to be running is a test suite that stops being run.
 *
 * Set `CARL_TEST_DB_DRIVER=pg` with `SUPABASE_DB_URL` to run the identical suite against a
 * real Supabase instance before release. The assertions do not change.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');
const SHIM_PATH = join(HERE, 'supabase-shim.sql');

/**
 * Reference data populated by migrations rather than by a test.
 *
 * `reset()` must leave these alone. Truncating them produced a genuinely baffling failure:
 * `provision_tenant()` found no role templates, granted the owner a null role, and the
 * cross-tenant integrity trigger reported CROSS_TENANT_REFERENCE — an error with no
 * apparent connection to the actual cause.
 */
const SEEDED_REFERENCE_TABLES = [
  'permissions',
  'role_templates',
  'role_template_permissions',
  'subscription_plans',
] as const;

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/**
 * A connection to a migrated Carl database, with helpers for impersonating callers.
 */
export interface TestDatabase {
  /** Runs a parameterised query as the currently-assumed role. */
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  /** Runs one or more statements with no parameters. */
  exec(sql: string): Promise<void>;

  /**
   * Runs `fn` as a signed-in end user.
   *
   * Sets both the database role and the JWT claims PostgREST would set, then restores the
   * previous identity afterwards — including when `fn` throws, so one failing test cannot
   * leave the connection impersonating someone else.
   */
  asUser<T>(userId: string, fn: () => Promise<T>, claims?: Record<string, unknown>): Promise<T>;

  /** Runs `fn` as an unauthenticated visitor. */
  asAnon<T>(fn: () => Promise<T>): Promise<T>;

  /** Runs `fn` as the trusted server role, which bypasses RLS. Use only to arrange fixtures. */
  asServiceRole<T>(fn: () => Promise<T>): Promise<T>;

  /**
   * Asserts a statement is refused.
   *
   * RLS denies reads by returning zero rows rather than erroring, so a "cannot read" test must
   * assert on emptiness; writes are refused with error 42501. This helper covers the write
   * case and is deliberately strict about *why* the statement failed — a query that fails
   * because of a typo would otherwise look like a passing security test.
   */
  expectDenied(sql: string, params?: readonly unknown[]): Promise<void>;

  /**
   * Asserts a statement ran but changed nothing.
   *
   * RLS refuses an INSERT with SQLSTATE 42501, but an UPDATE or DELETE against rows no
   * policy admits simply matches zero rows and reports success. Both are safe outcomes;
   * they are not the same outcome, and a test must assert the one that actually applies.
   * Using `expectDenied` for an UPDATE would fail even with the policy working correctly.
   */
  expectNoRowsAffected(sql: string, params?: readonly unknown[]): Promise<void>;

  /**
   * Whether this driver can express genuine concurrency.
   *
   * False for PGlite, which is an embedded single-connection engine: two instances over the
   * same data directory get separate snapshots rather than two sessions against one server,
   * so they cannot contend for a row lock. Tests that need a real race check this and skip
   * rather than pass vacuously — a green concurrency test that cannot fail is worse than
   * an absent one.
   */
  readonly supportsConcurrency: boolean;

  /**
   * Opens a second, independent session. Only available where `supportsConcurrency`.
   */
  concurrent(): Promise<TestDatabase>;

  /** Truncates all Carl tables, leaving the schema intact. */
  reset(): Promise<void>;

  close(): Promise<void>;
}

class PgliteTestDatabase implements TestDatabase {
  constructor(private readonly db: PGlite) {}

  readonly supportsConcurrency = false;

  concurrent(): Promise<TestDatabase> {
    return Promise.reject(
      new Error(
        'PGlite is an embedded single-connection engine and cannot open a second session ' +
          'against the same database. Run concurrency tests against a real PostgreSQL ' +
          '(CARL_TEST_DB_DRIVER=pg), or guard them with `supportsConcurrency`.',
      ),
    );
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    const result = await this.db.query<T>(sql, params as unknown[]);
    return { rows: result.rows, rowCount: result.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  private async withIdentity<T>(
    role: string,
    claims: Record<string, unknown> | null,
    fn: () => Promise<T>,
  ): Promise<T> {
    // Applied as LOCAL settings inside a transaction would be cleaner, but tests need to
    // commit, so identity is set and explicitly restored instead.
    await this.db.exec(
      claims === null
        ? `select set_config('request.jwt.claims', '', false)`
        : `select set_config('request.jwt.claims', ${literal(JSON.stringify(claims))}, false)`,
    );
    await this.db.exec(`set role ${role}`);
    try {
      return await fn();
    } finally {
      await this.db.exec('reset role');
      await this.db.exec(`select set_config('request.jwt.claims', '', false)`);
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

  async expectDenied(sql: string, params: readonly unknown[] = []): Promise<void> {
    try {
      await this.query(sql, params);
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      // 42501 = insufficient_privilege, which is what RLS and GRANT failures raise.
      if (code === '42501' || /row-level security|permission denied/i.test(message)) return;
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

  async reset(): Promise<void> {
    const { rows } = await this.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public'
         and tablename <> all($1::text[])
       order by tablename`,
      [SEEDED_REFERENCE_TABLES],
    );
    if (rows.length === 0) return;
    const tables = rows.map((r) => `public.${quoteIdent(r.tablename)}`).join(', ');
    await this.exec(`truncate table ${tables} restart identity cascade`);
    await this.exec('truncate table auth.users cascade');
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Reads the ordered list of migration files. Order is lexical, which is why they are dated. */
export async function migrationFiles(): Promise<string[]> {
  try {
    const entries = await readdir(MIGRATIONS_DIR);
    return entries.filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return [];
  }
}

export interface CreateTestDatabaseOptions {
  /** Skip applying migrations — for tests that assert on the migration process itself. */
  readonly skipMigrations?: boolean;
}

/**
 * Creates a fresh, fully-migrated database.
 *
 * Every call produces an isolated instance, so a test that corrupts data cannot affect
 * another file.
 */
export async function createTestDatabase(
  options: CreateTestDatabaseOptions = {},
): Promise<TestDatabase> {
  const driver = process.env.CARL_TEST_DB_DRIVER ?? 'pglite';
  if (driver !== 'pglite') {
    throw new Error(
      `CARL_TEST_DB_DRIVER="${driver}" is not supported yet. ` +
        'The `pg` driver is wired up in Phase 15 for pre-release verification against a real ' +
        'Supabase instance; until then use the default in-process PGlite driver.',
    );
  }

  const pglite = await PGlite.create({ extensions: { pgcrypto, pg_trgm, citext } });
  const db = new PgliteTestDatabase(pglite);

  // The shim must come first: migrations reference auth.uid() and grant to `authenticated`.
  await pglite.exec(await readFile(SHIM_PATH, 'utf8'));

  if (!options.skipMigrations) {
    for (const file of await migrationFiles()) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await pglite.exec(sql);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${file} failed to apply:\n  ${message}`, { cause: error });
      }
    }
  }

  return db;
}
