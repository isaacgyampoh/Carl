import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';

/**
 * Coverage, not behaviour.
 *
 * Individual isolation tests prove that the tables they exercise are protected. They say
 * nothing about a table added next month whose author forgot `ENABLE ROW LEVEL SECURITY` —
 * and that table would be readable by every tenant, silently, with no failing test.
 *
 * This suite enumerates the schema and asserts the protection holds for *every* table,
 * so the failure mode is a red build rather than a breach.
 */
describe('RLS coverage', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  it('enables row level security on every table in public', async () => {
    const { rows } = await db.query<{ tablename: string }>(
      `select c.relname as tablename
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'r'
         and not c.relrowsecurity
       order by c.relname`,
    );
    expect(
      rows.map((r) => r.tablename),
      'these tables are readable across tenant boundaries',
    ).toEqual([]);
  });

  it('forces row level security on every table, so the owner is not exempt', async () => {
    // ENABLE alone exempts the table owner — which is the role migrations run as, and the
    // role any SECURITY DEFINER function runs as. FORCE closes that.
    const { rows } = await db.query<{ tablename: string }>(
      `select c.relname as tablename
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'r'
         and c.relrowsecurity
         and not c.relforcerowsecurity
       order by c.relname`,
    );
    expect(
      rows.map((r) => r.tablename),
      'RLS is enabled but not forced',
    ).toEqual([]);
  });

  it('gives every RLS-enabled table at least one policy', async () => {
    // A table with RLS on and no policies denies everything. That is safe but usually
    // unintended, and it fails at runtime rather than here.
    const { rows } = await db.query<{ tablename: string }>(
      `select c.relname as tablename
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'r'
         and c.relrowsecurity
         and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
       order by c.relname`,
    );

    // These are written exclusively by transactional functions running as the service
    // role, which bypasses RLS. Denying all direct access is the intent.
    const intentionallyNoPolicy = ['idempotency_keys'];
    const unexpected = rows
      .map((r) => r.tablename)
      .filter((t) => !intentionallyNoPolicy.includes(t));
    expect(unexpected, 'RLS enabled but no policy defined').toEqual([]);
  });

  it('grants no table privileges to anon', async () => {
    // An unauthenticated caller should reach nothing at all. Relying on policies alone
    // would mean a future table with a permissive policy became world-readable.
    const { rows } = await db.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type
       from information_schema.role_table_grants
       where grantee = 'anon' and table_schema = 'public'
       order by table_name`,
    );
    expect(rows, 'anon holds table privileges it should not').toEqual([]);
  });

  it('never writes a policy that reads a client-supplied value', async () => {
    // Carl's isolation depends on policies resolving through auth.uid() and the database's
    // own membership records. A policy consulting current_setting() for anything other
    // than the verified JWT would be trusting the client.
    const { rows } = await db.query<{
      policyname: string;
      qual: string | null;
      withcheck: string | null;
    }>(
      `select polname as policyname,
              pg_get_expr(polqual, polrelid) as qual,
              pg_get_expr(polwithcheck, polrelid) as withcheck
       from pg_policy p
       join pg_class c on c.oid = p.polrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'`,
    );

    for (const row of rows) {
      const expression = `${row.qual ?? ''} ${row.withcheck ?? ''}`;
      expect(
        /current_setting\s*\(\s*'(?!request\.jwt)/.test(expression),
        `policy ${row.policyname} reads a session setting that a client could influence`,
      ).toBe(false);
    }
  });

  it('pins search_path on every SECURITY DEFINER function', async () => {
    // A SECURITY DEFINER function that resolves unqualified names through the caller's
    // search_path can be pointed at an attacker-created table and made to run with the
    // owner's privileges. This is the single most common PostgreSQL privilege-escalation
    // route, and it is a property the catalogue can be asked about directly.
    const { rows } = await db.query<{ schema: string; name: string }>(
      `select n.nspname as schema, p.proname as name
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'app')
         and p.prosecdef
         and (p.proconfig is null or not exists (
           select 1 from unnest(p.proconfig) cfg where cfg like 'search\\_path=%'
         ))
       order by n.nspname, p.proname`,
    );
    expect(
      rows.map((r) => `${r.schema}.${r.name}`),
      'SECURITY DEFINER functions without a pinned search_path',
    ).toEqual([]);
  });

  it('keeps the app helper schema off the API surface', async () => {
    // app.* functions are called by policies. A client able to call them directly could
    // enumerate membership across tenants.
    const { rows } = await db.query<{ has: boolean }>(
      `select has_schema_privilege('anon', 'app', 'usage') as has`,
    );
    expect(rows[0]!.has, 'anon can reach the app helper schema').toBe(false);
  });
});
