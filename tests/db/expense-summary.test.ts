import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { addMember, createBranch, createTenant } from '../support/fixtures.js';

/**
 * expense_summary: what a business spent, for Reports' expenses and net figures.
 *
 * Like every reporting aggregate it must be right, and it must not see further than the
 * caller: knowing a competitor's monthly spending does not require reading one expense.
 */
describe('expense_summary', () => {
  let db: TestDatabase;
  let sequence = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.reset();
  });

  async function expense(
    tenantId: string,
    branchId: string,
    createdBy: string,
    amount: number,
    status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'PAID',
    date = '2026-03-10',
  ): Promise<void> {
    sequence += 1;
    await db.asServiceRole(() =>
      db.query(
        `insert into expenses (tenant_id, branch_id, reference, description, amount, status, expense_date,
                               created_by, approved_by, approved_at, rejected_reason)
         values ($1, $2, $3, 'Test expense', $4, $5::expense_status, $6::date, $7,
                 case when $5 = 'APPROVED' then $7::uuid end,
                 case when $5 = 'APPROVED' then now() end,
                 case when $5 = 'REJECTED' then 'Not a business cost' end)`,
        [tenantId, branchId, `EXP-${sequence}`, amount, status, date, createdBy],
      ),
    );
  }

  async function summary(
    userId: string,
    tenantId: string,
    from = '2026-03-01T00:00:00Z',
    to = '2026-04-01T00:00:00Z',
    branchId: string | null = null,
  ) {
    const { rows } = await db.asUser(userId, () =>
      db.query<{
        expense_count: string;
        total: string;
        pending_count: string;
        pending_total: string;
      }>(`select * from expense_summary($1, $2::timestamptz, $3::timestamptz, $4)`, [
        tenantId,
        from,
        to,
        branchId,
      ]),
    );
    const row = rows[0]!;
    return {
      count: Number(row.expense_count),
      total: Number(row.total),
      pendingCount: Number(row.pending_count),
      pendingTotal: Number(row.pending_total),
    };
  }

  it('counts approved and paid expenses, reports pending apart, and ignores draft and rejected', async () => {
    const t = await createTenant(db);
    await expense(t.tenantId, t.branchId, t.ownerUserId, 50000, 'APPROVED');
    await expense(t.tenantId, t.branchId, t.ownerUserId, 20000, 'PAID');
    await expense(t.tenantId, t.branchId, t.ownerUserId, 7000, 'PENDING_APPROVAL');
    await expense(t.tenantId, t.branchId, t.ownerUserId, 900, 'DRAFT');
    await expense(t.tenantId, t.branchId, t.ownerUserId, 3000, 'REJECTED');

    expect(await summary(t.ownerUserId, t.tenantId)).toEqual({
      count: 2,
      total: 70000,
      pendingCount: 1,
      pendingTotal: 7000,
    });
  });

  it('uses a half-open range over the date the expense belongs to', async () => {
    const t = await createTenant(db);
    await expense(t.tenantId, t.branchId, t.ownerUserId, 1000, 'APPROVED', '2026-03-01'); // first day: in
    await expense(t.tenantId, t.branchId, t.ownerUserId, 2000, 'APPROVED', '2026-03-31'); // last day: in
    await expense(t.tenantId, t.branchId, t.ownerUserId, 4000, 'APPROVED', '2026-04-01'); // next month: out
    await expense(t.tenantId, t.branchId, t.ownerUserId, 8000, 'APPROVED', '2026-02-28'); // previous: out

    const march = await summary(t.ownerUserId, t.tenantId);
    expect(march.total).toBe(3000);
    expect(march.count).toBe(2);
  });

  it('returns zeroes rather than nulls for an empty range', async () => {
    const t = await createTenant(db);
    expect(await summary(t.ownerUserId, t.tenantId)).toEqual({
      count: 0,
      total: 0,
      pendingCount: 0,
      pendingTotal: 0,
    });
  });

  it('narrows to one branch when asked', async () => {
    const t = await createTenant(db);
    const kumasi = await createBranch(db, t.tenantId, 'kumasi', 'Kumasi');
    await expense(t.tenantId, t.branchId, t.ownerUserId, 10000, 'APPROVED');
    await expense(t.tenantId, kumasi, t.ownerUserId, 2500, 'APPROVED');

    expect((await summary(t.ownerUserId, t.tenantId)).total).toBe(12500);
    expect((await summary(t.ownerUserId, t.tenantId, undefined, undefined, kumasi)).total).toBe(
      2500,
    );
  });

  it('shows another business nothing of this one', async () => {
    const mine = await createTenant(db);
    const theirs = await createTenant(db);
    await expense(mine.tenantId, mine.branchId, mine.ownerUserId, 99000, 'APPROVED');

    const peek = await summary(theirs.ownerUserId, mine.tenantId);
    expect(peek.total).toBe(0);
    expect(peek.count).toBe(0);
  });

  it('shows a cashier, who cannot view expenses, nothing', async () => {
    const t = await createTenant(db);
    const cashier = await addMember(db, t.tenantId, { roleKey: 'cashier' });
    await expense(t.tenantId, t.branchId, t.ownerUserId, 45000, 'APPROVED');

    const seen = await summary(cashier.userId, t.tenantId);
    expect(seen.total).toBe(0);
    expect(seen.pendingTotal).toBe(0);
  });

  it('confines a branch-scoped member to their own branch', async () => {
    const t = await createTenant(db);
    const kumasi = await createBranch(db, t.tenantId, 'kumasi', 'Kumasi');
    const manager = await addMember(db, t.tenantId, {
      roleKey: 'tenant_admin',
      branchIds: [kumasi],
    });
    await expense(t.tenantId, t.branchId, t.ownerUserId, 10000, 'APPROVED');
    await expense(t.tenantId, kumasi, t.ownerUserId, 2500, 'APPROVED');

    expect((await summary(manager.userId, t.tenantId)).total).toBe(2500);
  });

  it('runs as the caller, with a pinned search_path, and is not callable anonymously', async () => {
    const { rows } = await db.asAdmin(() =>
      db.query<{ definer: boolean; pinned: boolean; anon: boolean; authenticated: boolean }>(
        `select p.prosecdef as definer,
                exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%') as pinned,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as authenticated
           from pg_proc p where p.proname = 'expense_summary'`,
      ),
    );
    expect(rows).toEqual([{ definer: false, pinned: true, anon: false, authenticated: true }]);
  });
});
