import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';

/**
 * Proves the test harness itself is trustworthy.
 *
 * Every security claim Carl makes rests on this harness genuinely enforcing RLS. If the shim
 * were subtly wrong — `auth.uid()` returning null, or the connection silently running as a
 * superuser — the entire RLS suite would pass while proving nothing. These tests fail loudly
 * in that case.
 */
describe('database test harness', () => {
  let db: TestDatabase;

  const ALICE = '11111111-1111-4111-8111-111111111111';
  const BOB = '22222222-2222-4222-8222-222222222222';

  beforeAll(async () => {
    db = await createTestDatabase();
    // Dropped first: against a real project the database persists between runs, so a
    // bare CREATE fails on the second run with "already exists".
    await db.exec('drop table if exists public.harness_note cascade');
    await db.exec(`
      create table public.harness_note (
        id       uuid primary key default gen_random_uuid(),
        owner_id uuid not null,
        body     text not null
      );
      alter table public.harness_note enable row level security;
      alter table public.harness_note force row level security;

      create policy harness_note_select on public.harness_note
        for select to authenticated using (owner_id = (select auth.uid()));
      create policy harness_note_insert on public.harness_note
        for insert to authenticated with check (owner_id = (select auth.uid()));
      create policy harness_note_delete on public.harness_note
        for delete to authenticated using (owner_id = (select auth.uid()));

      grant select, insert, update, delete on public.harness_note to authenticated;
    `);
    await db.exec(`
      insert into public.harness_note (owner_id, body) values
        ('${ALICE}', 'alice private note'),
        ('${BOB}',   'bob private note');
    `);
  });

  it('runs a multi-statement script without losing its result', async () => {
    /*
     * A regression test for a real harness defect.
     *
     * node-postgres returns a single result for one statement and an ARRAY of results when
     * the text contains several. The harness read `.rows` off that array, got `undefined`,
     * and `.rows.length` threw — taking down every test in the file from inside a hook.
     *
     * It only ever failed against the real driver: PGlite returns a single result either
     * way, so a full PGlite suite stayed green while two files died on real PostgreSQL.
     * `exec()` sends multi-statement SQL routinely — the seed file, batches of DDL — so
     * this was not an exotic path.
     *
     * This half runs on both drivers, because this is the half that broke.
     */
    await db.exec(`
      drop table if exists public.harness_multi cascade;
      create table public.harness_multi (id int primary key, label text);
      insert into public.harness_multi (id, label) values (1, 'first'), (2, 'second');
    `);

    const { rows } = await db.query<{ n: string }>(
      'select count(*)::text as n from public.harness_multi',
    );
    expect(rows[0]!.n).toBe('2');

    await db.exec('drop table if exists public.harness_multi cascade');
  });

  it('returns the last statement’s rows from a multi-statement query', async (ctx) => {
    /*
     * The precise shape the defect got wrong, asserted only where the shape exists.
     *
     * PGlite prepares every statement and rejects multi-statement text outright, so there
     * is no "last result" for it to return. Asserting node-postgres's behaviour there
     * would fail on a driver difference rather than on anything Carl does, which is how
     * a suite starts being re-run instead of read.
     */
    if (!db.supportsMultiStatementQuery) {
      ctx.skip('this driver prepares every statement and cannot run several at once');
      return;
    }

    await db.exec(`
        drop table if exists public.harness_multi cascade;
        create table public.harness_multi (id int primary key, label text);
        insert into public.harness_multi (id, label) values (1, 'first'), (2, 'second');
      `);

    const result = await db.query<{ label: string }>(`
        select label from public.harness_multi where id = 1;
        select label from public.harness_multi where id = 2;
      `);
    expect(result.rows[0]!.label).toBe('second');
    expect(result.rowCount).toBe(1);

    await db.exec('drop table if exists public.harness_multi cascade');
  });

  afterAll(async () => {
    await db?.close();
  });

  it('runs a genuine PostgreSQL server', async () => {
    const { rows } = await db.query<{ version: string }>('select version()');
    expect(rows[0]?.version).toMatch(/PostgreSQL/);
  });

  it('resolves auth.uid() from the injected JWT claims', async () => {
    const uid = await db.asUser(ALICE, async () => {
      const { rows } = await db.query<{ uid: string }>('select auth.uid() as uid');
      return rows[0]?.uid;
    });
    expect(uid).toBe(ALICE);
  });

  it('actually assumes the authenticated role rather than staying superuser', async () => {
    const role = await db.asUser(ALICE, async () => {
      const { rows } = await db.query<{ role: string }>('select current_user as role');
      return rows[0]?.role;
    });
    expect(role).toBe('authenticated');
  });

  it('enforces row level security on reads', async () => {
    const alice = await db.asUser(ALICE, () =>
      db.query<{ body: string }>('select body from public.harness_note'),
    );
    expect(alice.rows).toHaveLength(1);
    expect(alice.rows[0]?.body).toBe('alice private note');

    const bob = await db.asUser(BOB, () =>
      db.query<{ body: string }>('select body from public.harness_note'),
    );
    expect(bob.rows).toHaveLength(1);
    expect(bob.rows[0]?.body).toBe('bob private note');
  });

  it('refuses a write that forges another user as the owner', async () => {
    await db.asUser(ALICE, () =>
      db.expectDenied(`insert into public.harness_note (owner_id, body) values ($1, 'forged')`, [
        BOB,
      ]),
    );
  });

  it('silently affects nothing when deleting another user’s row', async () => {
    // RLS filters DELETE rather than erroring, so the defence is "zero rows affected".
    await db.asUser(ALICE, async () => {
      const { rows } = await db.query(
        `delete from public.harness_note where owner_id = $1 returning id`,
        [BOB],
      );
      expect(rows).toHaveLength(0);
    });
    const remaining = await db.asServiceRole(() =>
      db.query<{ n: number }>('select count(*)::int as n from public.harness_note'),
    );
    expect(remaining.rows[0]?.n).toBe(2);
  });

  it('denies anonymous access entirely', async () => {
    await db.asAnon(() => db.expectDenied('select * from public.harness_note'));
  });

  it('lets the service role bypass RLS, as trusted server code requires', async () => {
    const all = await db.asServiceRole(() => db.query('select * from public.harness_note'));
    expect(all.rows).toHaveLength(2);
  });

  it('restores the previous identity even when a test body throws', async () => {
    await expect(db.asUser(ALICE, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    const { rows } = await db.query<{ role: string }>('select current_user as role');
    expect(rows[0]?.role).not.toBe('authenticated');
  });

  it('fails a denial assertion when the statement was merely broken', async () => {
    await expect(
      db.asUser(ALICE, () => db.expectDenied('select * from public.table_that_does_not_exist')),
    ).rejects.toThrow(/not proving what it claims/);
  });
});
