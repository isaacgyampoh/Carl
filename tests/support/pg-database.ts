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

/**
 * Node socket and DNS faults. These mean the statement never reached PostgreSQL.
 *
 * `ENOTFOUND` and `EADDRNOTAVAIL` are here because a definitive run lost DNS resolution
 * 37 minutes in: eighteen suites failed at `beforeAll` with `getaddrinfo ENOTFOUND`, which
 * reads exactly like a schema regression and was a laptop losing its network.
 */
const TRANSPORT_FAULT =
  /Connection terminated|not queryable|Client has encountered a connection error|server closed the connection|getaddrinfo|ECONNRESET|EPIPE|ENOTFOUND|EADDRNOTAVAIL|ECONNREFUSED|ENETUNREACH|ENETDOWN|ETIMEDOUT|EHOSTUNREACH|socket hang up/i;

/**
 * Whether a failure means the connection is gone rather than the statement was bad.
 *
 * The discriminator is `pg.DatabaseError`: PostgreSQL only produces one after it has
 * received, parsed and refused the statement. So a constraint violation, a permission
 * denial, or a RAISE from a function is never retried, no matter what its message says —
 * which matters because these tests assert that writes *fail*, and a retry that turned a
 * refusal into a pass would be a security test lying.
 *
 * Everything retried here is a fault below the protocol, where the server never saw the
 * statement at all.
 */
export function isConnectionError(error: unknown): boolean {
  // The server answered. Whatever it said, it is the answer.
  if (error instanceof pg.DatabaseError) return false;

  // Not every rejection is an object. Reading `.code` off a thrown null would replace the
  // real failure with a TypeError from inside the error handler, which is how a plain bug
  // ends up reported as something unrelated.
  if (typeof error !== 'object' || error === null) return false;

  const code = (error as { code?: string }).code ?? '';
  // Only Errors carry a usable message; anything else is judged on its code alone rather
  // than stringified into "[object Object]" and matched against that.
  const message = error instanceof Error ? error.message : '';
  return TRANSPORT_FAULT.test(code) || TRANSPORT_FAULT.test(message);
}

/** The client options every connection in this driver uses. */
function clientOptions(connectionString: string): pg.ClientConfig {
  return {
    connectionString,
    // Supabase terminates TLS at the pooler with a certificate chain Node does not carry
    // by default. The connection is still encrypted; only chain verification is relaxed.
    ssl: { rejectUnauthorized: false },
    // A hung connection should fail the suite quickly rather than sit until the hook
    // timeout, which makes the cause much harder to see.
    connectionTimeoutMillis: 15_000,
    statement_timeout: 60_000,
    // Keeps the pooler from recycling an idle connection during a long run.
    keepAlive: true,
  };
}

/**
 * Opens a connection, tolerating a network that is briefly unavailable.
 *
 * ## A fresh client per attempt, which is the whole point
 *
 * A `pg.Client` is single-use. Once `connect()` has been called on one — even if it failed
 * — that client is spent, and calling `connect()` again throws:
 *
 *     Client has already been connected. You cannot reuse a client.
 *
 * An earlier version of this function retried on the same client. The result was worse than
 * having no retry at all: a momentary network fault became a hard failure with a message
 * describing a bug in the harness rather than the network, and it took out ten tests across
 * six suites in one run. So the client is constructed here, per attempt, and never handed in.
 *
 * Bounded on purpose: a genuinely wrong host or a rotated password must still fail, and
 * fail while the person who typed it is still watching.
 */
export async function connect(connectionString: string, attempts = 4): Promise<pg.Client> {
  for (let attempt = 1; ; attempt += 1) {
    const client = new pg.Client(clientOptions(connectionString));
    try {
      await client.connect();
      return client;
    } catch (error) {
      // Nothing reuses this one, but leaving a half-open socket behind would leak a
      // connection slot on the pooler for every failed attempt.
      await client.end().catch(() => undefined);
      // An authentication failure is an answer from the server, not a transport fault.
      if (attempt >= attempts || !isConnectionError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
}

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
  readonly supportsMultiStatementQuery = true;

  /**
   * Set when the connection dies underneath us.
   *
   * A full run takes the better part of an hour, and a pooled connection held open that
   * long will eventually be recycled or dropped. When that happened the first time, the
   * in-flight test timed out and every remaining test in the file failed with "Client has
   * encountered a connection error and is not queryable" — fifteen failures from one
   * network event, which reads like a code defect and is not one.
   */
  private dead = false;

  constructor(
    private client: pg.Client,
    private readonly connectionString: string,
  ) {
    this.watch();
  }

  /** A dropped connection surfaces as an `error` event, not as a rejected query. */
  private watch(): void {
    this.client.on('error', () => {
      this.dead = true;
    });
  }

  private async reconnect(): Promise<void> {
    try {
      await this.client.end();
    } catch {
      // Already gone. Nothing to close.
    }
    // `connect` builds the client, because a spent one cannot be reconnected.
    this.client = await connect(this.connectionString);
    this.watch();
    this.dead = false;
  }

  /**
   * Normalises what `pg` hands back.
   *
   * node-postgres returns a single result for one statement and an ARRAY of results when
   * the text contains several — which `exec()` routinely sends, for a seed file or a batch
   * of DDL. Reading `.rows` off the array yields `undefined`, and `.rows.length` then
   * throws `Cannot read properties of undefined`, taking down the whole file in a hook.
   *
   * The last statement's result is the meaningful one: a caller running several statements
   * is asking about the outcome of the final one. PGlite returns a single result either
   * way, which is why this only ever failed against the real driver.
   */
  private static normalise<T>(result: unknown): QueryResult<T> {
    const last = Array.isArray(result) ? result[result.length - 1] : result;
    const rows = ((last as { rows?: unknown[] } | undefined)?.rows ?? []) as T[];
    const rowCount = (last as { rowCount?: number | null } | undefined)?.rowCount;
    return { rows, rowCount: rowCount ?? rows.length };
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    if (this.dead) await this.reconnect();

    try {
      return PgTestDatabase.normalise<T>(await this.client.query(sql, params as unknown[]));
    } catch (error) {
      // Only a *connection* failure is retried. A statement that was refused, or that
      // violated a constraint, must propagate — retrying it would turn a real failure into
      // a confusing one, and could double-apply a write that had already committed.
      if (!isConnectionError(error)) throw error;

      await this.reconnect();
      return PgTestDatabase.normalise<T>(await this.client.query(sql, params as unknown[]));
    }
  }

  async exec(sql: string): Promise<void> {
    await this.query(sql);
  }

  private async withIdentity<T>(
    role: string,
    claims: Record<string, unknown> | null,
    fn: () => Promise<T>,
  ): Promise<T> {
    // Through `query()`, not the raw client: these run at the start of every test, so a
    // connection that died between tests must be rebuilt here rather than turning the next
    // suite red. Setting a role and a claim is idempotent, so a retry is always safe.
    await this.query(`select set_config('request.jwt.claims', $1, false)`, [
      claims === null ? '' : JSON.stringify(claims),
    ]);
    await this.query(`set role ${role}`);
    try {
      return await fn();
    } finally {
      // Restored even when the body throws, so one failing test cannot leave the
      // connection impersonating someone else for every test after it.
      //
      // A reconnect resets the role by itself, so failing to reset it on a dead connection
      // is not a leak — and must not mask the error that killed it.
      await this.query('reset role').catch(() => undefined);
      await this.query(`select set_config('request.jwt.claims', '', false)`).catch(() => undefined);
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
    await this.query('reset role');
    try {
      return await fn();
    } finally {
      if (previous && previous !== 'postgres') {
        await this.query(`set role ${previous}`).catch(() => undefined);
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
    return new PgTestDatabase(await connect(this.connectionString), this.connectionString);
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
    await this.query('reset role').catch(() => undefined);
    // A DO block is not a prepared statement and cannot take bind parameters, so the
    // preserved-table list is inlined. These are compile-time constants in this file, not
    // caller input, and each is quoted as a literal regardless.
    const preserved = SEEDED_REFERENCE_TABLES.map((t) => `'${t}'`).join(', ');

    // Through `query()`: `reset()` runs in `beforeEach`, and this is the exact statement
    // that failed on a dead connection in the run that lost DNS — one network event, 242
    // skipped tests. Truncation is idempotent, so a reconnect-and-retry is safe.
    await this.query(
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
    /*
     * Reclaim catalogue churn before disconnecting.
     *
     * Even truncating only populated tables, a full run rewrites enough of pg_class to add
     * roughly 370 kB per pass — down from twelve times that, but not zero. Left alone
     * across many runs it eventually fills a small project's disk, which is how this suite
     * once died with "No space left on device".
     *
     * A transaction-per-test rollback would avoid the churn entirely and is the better
     * long-term answer. It is not done here because it requires a SAVEPOINT around every
     * statement that is expected to fail, and a mishandled savepoint makes a security test
     * pass for the wrong reason — a worse outcome than some catalogue bloat.
     *
     * Failure is ignored: reclaiming space must never be the reason a suite reports red.
     */
    try {
      /*
       * Bounded, because reclaiming space must never be the reason a suite reports red.
       *
       * Without a timeout this ran under the driver's ordinary 60s statement limit but
       * inside a 300s `afterAll` hook, and on a contended database it exhausted the hook —
       * turning a housekeeping step into four failed suites whose stack traces pointed at
       * `afterAll` and said nothing about vacuuming.
       *
       * 20 seconds is enough on an idle database and is abandoned without complaint on a
       * busy one. The catalogue bloat it prevents accrues slowly; a red suite does not.
       */
      // Session-level, not `set local`: LOCAL only applies inside a transaction, and
      // VACUUM cannot run in one — so `set local` here would be a silent no-op and the
      // bound would not exist. The connection is closed immediately afterwards, so
      // changing the session setting affects nothing else.
      await this.client.query('set statement_timeout = 20000');
      await this.client.query('vacuum pg_class, pg_attribute, pg_depend, pg_type');
    } catch {
      // Not permitted, timed out, or the connection is already gone. None affects the
      // result of the tests that just ran.
    }
    await this.client.end().catch(() => undefined);
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

  // Retrying: every suite file opens its own connection, so a momentary network blip
  // would otherwise fail eighteen `beforeAll` hooks at once.
  const client = await connect(connectionString);
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
