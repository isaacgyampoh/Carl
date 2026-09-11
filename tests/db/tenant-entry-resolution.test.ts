import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { addMember, createTenant, createUser } from '../support/fixtures.js';

/**
 * REGRESSION: a client's URL opened the platform owner's console.
 *
 * These run against real migrations and real RLS, as each database role, and assert the
 * facts the fix depends on:
 *
 *   1. RLS lets the platform owner READ another business's membership rows. That is by
 *      design (migration 0028, the staff list on a client's profile), and it is exactly why
 *      "a membership row exists at this slug" cannot mean "the caller belongs here".
 *   2. With the caller's own user id in the query, as the app now issues it, each address
 *      resolves to its own business for its own members and to nothing for anyone else,
 *      the platform owner included.
 *   3. A member can READ every role's permissions in their business, so permissions must be
 *      taken from the caller's own roles or a cashier inherits the owner's.
 *
 * The unit test `tenant-entry-resolution.test.ts` runs the application's resolution code
 * itself against the worst case of (1); this file proves (1) and (3) are the real policy.
 */
describe('tenant entry resolution against real RLS', () => {
  let db: TestDatabase;
  let clientA: Awaited<ReturnType<typeof createTenant>>;
  let clientB: Awaited<ReturnType<typeof createTenant>>;
  let platformOwner: string;
  let cashierA: { userId: string; membershipId: string };

  beforeAll(async () => {
    db = await createTestDatabase();
    clientA = await createTenant(db, { name: 'Client A' });
    clientB = await createTenant(db, { name: 'Client B' });
    platformOwner = await createUser(db, { isPlatformAdmin: true, scaffoldingPin: true });
    cashierA = await addMember(db, clientA.tenantId, { roleKey: 'cashier' });
  });

  afterAll(async () => {
    await db?.close();
  });

  /** The membership check the app issues at `/[slug]`: own user id, slug, active. */
  async function enters(userId: string, slug: string): Promise<string | null> {
    const { rows } = await db.asUser(userId, () =>
      db.query<{ tenant_id: string }>(
        `select m.tenant_id
           from tenant_memberships m join tenants t on t.id = m.tenant_id
          where m.user_id = $1 and t.slug = $2 and m.status = 'ACTIVE'
          limit 1`,
        [userId, slug],
      ),
    );
    return rows[0]?.tenant_id ?? null;
  }

  it("lets the platform owner READ another business's membership rows (why the filter exists)", async () => {
    const { rows } = await db.asUser(platformOwner, () =>
      db.query<{ user_id: string }>(
        `select m.user_id from tenant_memberships m join tenants t on t.id = m.tenant_id
          where t.slug = $1 and m.status = 'ACTIVE'`,
        [clientA.slug],
      ),
    );
    // The unfiltered question the entry page used to ask: rows come back, none of them the
    // owner's. Treating this as membership is what opened the owner console at a client URL.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.user_id === platformOwner)).toBe(false);
  });

  it("resolves Client A's URL to Client A for Client A's administrator", async () => {
    expect(await enters(clientA.ownerUserId, clientA.slug)).toBe(clientA.tenantId);
  });

  it("resolves Client B's URL to Client B for Client B's administrator", async () => {
    expect(await enters(clientB.ownerUserId, clientB.slug)).toBe(clientB.tenantId);
  });

  it("denies Client B's administrator at Client A's URL", async () => {
    expect(await enters(clientB.ownerUserId, clientA.slug)).toBeNull();
  });

  it("denies Client A's administrator at Client B's URL", async () => {
    expect(await enters(clientA.ownerUserId, clientB.slug)).toBeNull();
  });

  it('never resolves a client URL into the platform owner, and never lets the owner in', async () => {
    expect(await enters(platformOwner, clientA.slug)).toBeNull();
    expect(await enters(platformOwner, clientB.slug)).toBeNull();

    const { rows } = await db.asUser(platformOwner, () =>
      db.query(`select 1 from tenant_memberships where user_id = $1 and status = 'ACTIVE'`, [
        platformOwner,
      ]),
    );
    expect(rows, 'the platform owner has no business of their own').toHaveLength(0);
  });

  it("gives a cashier their own role's permissions, though they can read every role's", async () => {
    const everyRole = await db.asUser(cashierA.userId, () =>
      db.query<{ permission_key: string }>(
        `select distinct rp.permission_key from role_permissions rp join roles r on r.id = rp.role_id
          where r.tenant_id = $1`,
        [clientA.tenantId],
      ),
    );
    const readable = everyRole.rows.map((row) => row.permission_key);
    // The trap: the business's full permission list is readable by a cashier.
    expect(readable).toContain('reports.view');

    // What the app now reads: the roles on the caller's own membership.
    const own = await db.asUser(cashierA.userId, () =>
      db.query<{ permission_key: string }>(
        `select distinct rp.permission_key
           from membership_roles mr
           join roles r on r.id = mr.role_id
           join role_permissions rp on rp.role_id = r.id
          where mr.membership_id = $1`,
        [cashierA.membershipId],
      ),
    );
    const mine = own.rows.map((row) => row.permission_key);

    const cashierRole = await db.asServiceRole(() =>
      db.query<{ permission_key: string }>(
        `select rp.permission_key from role_permissions rp join roles r on r.id = rp.role_id
          where r.tenant_id = $1 and r.key = 'cashier'`,
        [clientA.tenantId],
      ),
    );

    expect(mine.sort()).toEqual(cashierRole.rows.map((row) => row.permission_key).sort());
    expect(mine).toContain('sales.create');
    expect(mine).not.toContain('reports.view');
    expect(mine).not.toContain('staff.manage');
    expect(mine).not.toContain('expenses.view');
  });
});
