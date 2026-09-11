import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { addMember, createBranch, createTenant, type TenantFixture } from '../support/fixtures.js';

/**
 * The read policies on the tables that carry volume no longer ask `app.can_read` about every
 * row. They compare a column against a set resolved once per statement —
 * `app.readable_tenant_ids(permission)` and `app.readable_branch_ids(permission)` — which is
 * what took the sales list from 99 seconds to 71 milliseconds at a year's volume.
 *
 * That is only safe while the sets say exactly what `app.can_read` says. This suite asserts
 * the equivalence directly, for every combination of person, business, branch and permission
 * in a fixture built to have all the awkward cases in it:
 *
 *   - two businesses, so a member of one must be absent from the other's sets
 *   - a second branch, and a cashier confined to one of them
 *   - a role that holds `sales.view` but not `sales.view_all`
 *   - a person with no membership anywhere
 *
 * If someone changes a helper, a permission grant, or `app.can_read` itself and the two
 * drift apart, this fails — rather than a business quietly seeing another's sales.
 */
describe('the readable sets agree with app.can_read', () => {
  let db: TestDatabase;
  let first: TenantFixture;
  let second: TenantFixture;
  let secondBranchId: string;
  let cashierUserId: string;
  let confinedCashierId: string;
  let strangerUserId: string;

  /** Every person the comparison is made as, including one who belongs to neither business. */
  const PEOPLE = () => [
    first.ownerUserId,
    second.ownerUserId,
    cashierUserId,
    confinedCashierId,
    strangerUserId,
  ];
  const TENANTS = () => [first.tenantId, second.tenantId];
  const BRANCHES = () => [
    { id: first.branchId, tenantId: first.tenantId },
    { id: secondBranchId, tenantId: first.tenantId },
    { id: second.branchId, tenantId: second.tenantId },
  ];

  const PERMISSIONS = [
    'sales.view',
    'sales.view_all',
    'products.view',
    'inventory.view',
    'reports.view',
  ];

  beforeAll(async () => {
    db = await createTestDatabase();
    await db.reset();

    first = await createTenant(db, { name: 'First Business' });
    second = await createTenant(db, { name: 'Second Business' });
    secondBranchId = await createBranch(db, first.tenantId, 'two', 'Second Branch');

    ({ userId: cashierUserId } = await addMember(db, first.tenantId, { roleKey: 'cashier' }));
    ({ userId: confinedCashierId } = await addMember(db, first.tenantId, {
      roleKey: 'cashier',
      branchIds: [secondBranchId],
    }));
    ({ userId: strangerUserId } = await addMember(db, second.tenantId, { roleKey: 'cashier' }));
  });

  afterAll(async () => {
    await db?.close();
  });

  it.each(PERMISSIONS)(
    'for %s, the tenant set is exactly what can_read allows',
    async (permission) => {
      for (const userId of PEOPLE()) {
        for (const tenantId of TENANTS()) {
          /*
           * Asked about a named id rather than by selecting from the table: `tenants` is
           * itself protected, so a query over it can only ever return rows the person may
           * already read. The interesting case is the business they may NOT read, which such
           * a query never returns.
           */
          const { rows } = await db.asUser(userId, () =>
            db.query<{ in_set: boolean; can_read: boolean }>(
              `select $2::uuid = any (app.readable_tenant_ids($1)) as in_set,
                      app.can_read($2::uuid, $1) as can_read`,
              [permission, tenantId],
            ),
          );
          expect(
            rows[0]!.in_set,
            `${permission}: readable_tenant_ids disagrees with can_read for ${tenantId}`,
          ).toBe(rows[0]!.can_read);
        }
      }
    },
  );

  it.each(PERMISSIONS)(
    'for %s, the branch set is exactly what can_read allows',
    async (permission) => {
      for (const userId of PEOPLE()) {
        for (const branch of BRANCHES()) {
          const { rows } = await db.asUser(userId, () =>
            db.query<{ in_set: boolean; can_read: boolean }>(
              `select $2::uuid = any (app.readable_branch_ids($1)) as in_set,
                      app.can_read($3::uuid, $1, $2::uuid) as can_read`,
              [permission, branch.id, branch.tenantId],
            ),
          );
          expect(
            rows[0]!.in_set,
            `${permission}: readable_branch_ids disagrees with can_read for ${branch.id}`,
          ).toBe(rows[0]!.can_read);
        }
      }
    },
  );

  it('a cashier confined to one branch is in that branch set and no other', async () => {
    const { rows } = await db.asUser(confinedCashierId, () =>
      db.query<{ branches: string[] }>(`select app.readable_branch_ids('sales.view') as branches`),
    );
    expect(rows[0]!.branches).toEqual([secondBranchId]);
  });

  it('a person with no membership reads nothing, rather than everything', async () => {
    const { rows } = await db.asUser(strangerUserId, () =>
      db.query<{ tenants: string[]; branches: string[] }>(
        `select app.readable_tenant_ids('sales.view') as tenants,
                app.readable_branch_ids('sales.view') as branches`,
      ),
    );
    expect(rows[0]!.tenants).toEqual([second.tenantId]);
    expect(rows[0]!.branches).not.toContain(first.branchId);
    expect(rows[0]!.branches).not.toContain(secondBranchId);
  });
});
