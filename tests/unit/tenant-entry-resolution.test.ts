import { describe, expect, it } from 'vitest';

import {
  memberTenantAtSlug,
  resolveAuthContext,
} from '../../packages/infrastructure/src/auth/resolve-auth-context';
import type { CarlSupabaseClient } from '../../packages/infrastructure/src/supabase/server-client';

/**
 * REGRESSION: a client's URL opened the platform owner's console.
 *
 * Root cause: the shop entry page and the tenant resolver treated "rows RLS lets me read" as
 * "my memberships". Migration 0028 lets the platform owner read every business's
 * memberships, so the owner was taken to be a member of every business, let in at a client's
 * address, and handed that business as their tenant inside their own console.
 *
 * This runs the REAL resolution code against a database that returns every membership row
 * to everyone, the worst case RLS allows the owner. Correct code must still resolve only
 * the caller's own businesses. Removing an own-user filter fails these tests.
 */

type Row = Record<string, unknown>;

function at(row: Row, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (value, key) => (value && typeof value === 'object' ? (value as Row)[key] : undefined),
      row,
    );
}

class Query implements PromiseLike<{ data: Row[]; error: null }> {
  constructor(private rows: Row[]) {}
  select() {
    return this;
  }
  eq(path: string, value: unknown) {
    this.rows = this.rows.filter((row) => at(row, path) === value);
    return this;
  }
  neq(path: string, value: unknown) {
    this.rows = this.rows.filter((row) => at(row, path) !== value);
    return this;
  }
  order() {
    return this;
  }
  limit(count: number) {
    this.rows = this.rows.slice(0, count);
    return this;
  }
  returns() {
    return this;
  }
  maybeSingle() {
    return Promise.resolve({ data: this.rows[0] ?? null, error: null });
  }
  then<A = { data: Row[]; error: null }, B = never>(
    onFulfilled?: ((value: { data: Row[]; error: null }) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve({ data: this.rows, error: null }).then(onFulfilled, onRejected);
  }
}

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';

const tenants = {
  [TENANT_A]: { slug: 'client-a', name: 'Client A', status: 'ACTIVE' },
  [TENANT_B]: { slug: 'client-b', name: 'Client B', status: 'ACTIVE' },
};

const OWNER_PERMISSIONS = ['reports.view', 'sales.create', 'sales.view_all', 'staff.manage'];
const CASHIER_PERMISSIONS = ['sales.create', 'sales.view'];

const users = {
  platformOwner: 'user-platform-owner',
  adminA: 'user-admin-a',
  adminB: 'user-admin-b',
  cashierA: 'user-cashier-a',
  inBoth: 'user-in-both',
};

const memberships: Row[] = [
  {
    id: 'm-admin-a',
    tenant_id: TENANT_A,
    user_id: users.adminA,
    status: 'ACTIVE',
    tenants: tenants[TENANT_A],
  },
  {
    id: 'm-admin-b',
    tenant_id: TENANT_B,
    user_id: users.adminB,
    status: 'ACTIVE',
    tenants: tenants[TENANT_B],
  },
  {
    id: 'm-cashier-a',
    tenant_id: TENANT_A,
    user_id: users.cashierA,
    status: 'ACTIVE',
    tenants: tenants[TENANT_A],
  },
  {
    id: 'm-both-a',
    tenant_id: TENANT_A,
    user_id: users.inBoth,
    status: 'ACTIVE',
    tenants: tenants[TENANT_A],
  },
  {
    id: 'm-both-b',
    tenant_id: TENANT_B,
    user_id: users.inBoth,
    status: 'ACTIVE',
    tenants: tenants[TENANT_B],
  },
];

const grants = (membershipId: string, keys: string[]): Row => ({
  membership_id: membershipId,
  roles: { role_permissions: keys.map((permission_key) => ({ permission_key })) },
});

const membershipRoles: Row[] = [
  grants('m-admin-a', OWNER_PERMISSIONS),
  grants('m-admin-b', OWNER_PERMISSIONS),
  grants('m-cashier-a', CASHIER_PERMISSIONS),
  grants('m-both-a', OWNER_PERMISSIONS),
  grants('m-both-b', OWNER_PERMISSIONS),
];

/** A database that shows EVERY row of these tables to every caller. */
function databaseAs(userId: string): CarlSupabaseClient {
  const tables: Record<string, Row[]> = {
    profiles: Object.values(users).map((id) => ({
      id,
      email: `${id}@example.test`,
      full_name: id,
    })),
    platform_admins: [{ user_id: users.platformOwner }],
    tenant_memberships: memberships,
    membership_roles: membershipRoles,
    branches: [
      { id: 'branch-a', tenant_id: TENANT_A, code: 'main', name: 'A Main', is_active: true },
      { id: 'branch-b', tenant_id: TENANT_B, code: 'main', name: 'B Main', is_active: true },
    ],
  };
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: { id: userId } }, error: null }) },
    from: (table: string) => new Query([...(tables[table] ?? [])]),
  } as unknown as CarlSupabaseClient;
}

describe('a client URL resolves to that client, and never to the platform owner', () => {
  it.each([
    ['Client A administrator', users.adminA, 'client-a', TENANT_A],
    ['Client B administrator', users.adminB, 'client-b', TENANT_B],
    ['Client A cashier', users.cashierA, 'client-a', TENANT_A],
  ])('%s at their own URL enters their own business', async (_who, userId, slug, tenantId) => {
    await expect(memberTenantAtSlug(databaseAs(userId), userId, slug)).resolves.toEqual({
      tenantId,
    });
  });

  it.each([
    ['Client B administrator at Client A URL', users.adminB, 'client-a'],
    ['Client A administrator at Client B URL', users.adminA, 'client-b'],
    ['Client A cashier at Client B URL', users.cashierA, 'client-b'],
    // The bug: the owner can read Client A's memberships, and was let in on that basis.
    ['Platform owner at Client A URL', users.platformOwner, 'client-a'],
    ['Platform owner at Client B URL', users.platformOwner, 'client-b'],
    ['anyone at an address no business has', users.adminA, 'no-such-business'],
  ])("%s is not let in: they get that business's PIN door", async (_who, userId, slug) => {
    await expect(memberTenantAtSlug(databaseAs(userId), userId, slug)).resolves.toBeNull();
  });

  it('never gives the platform owner a business, whatever the session cookie names', async () => {
    for (const requestedTenantId of [undefined, TENANT_A, TENANT_B]) {
      const auth = await resolveAuthContext(databaseAs(users.platformOwner), { requestedTenantId });
      expect(auth?.user.isPlatformAdmin).toBe(true);
      expect(auth?.tenant, `cookie ${requestedTenantId ?? 'absent'}`).toBeNull();
    }
  });

  it('resolves an administrator to their own business only', async () => {
    const a = await resolveAuthContext(databaseAs(users.adminA), { requestedTenantId: TENANT_A });
    expect(a?.tenant?.tenantId).toBe(TENANT_A);

    // A stale or forged cookie naming another business never yields that business.
    const forged = await resolveAuthContext(databaseAs(users.adminB), {
      requestedTenantId: TENANT_A,
    });
    expect(forged?.tenant?.tenantId).not.toBe(TENANT_A);
    expect(forged?.tenant?.tenantId).toBe(TENANT_B);
  });

  it('does not pick "the first" business for someone in several without a choice', async () => {
    const none = await resolveAuthContext(databaseAs(users.inBoth));
    expect(none?.tenant).toBeNull();

    const chosen = await resolveAuthContext(databaseAs(users.inBoth), {
      requestedTenantId: TENANT_B,
    });
    expect(chosen?.tenant?.tenantId).toBe(TENANT_B);
  });
});

describe("a person carries their own roles' permissions, not every role's in the business", () => {
  it("gives a cashier the cashier's permissions and nothing of the owner's", async () => {
    const auth = await resolveAuthContext(databaseAs(users.cashierA), {
      requestedTenantId: TENANT_A,
    });
    expect([...(auth?.tenant?.permissions ?? [])].sort()).toEqual([...CASHIER_PERMISSIONS].sort());
    expect(auth?.tenant?.permissions.has('reports.view')).toBe(false);
    expect(auth?.tenant?.permissions.has('staff.manage')).toBe(false);
  });

  it("gives an administrator their own role's permissions", async () => {
    const auth = await resolveAuthContext(databaseAs(users.adminA), {
      requestedTenantId: TENANT_A,
    });
    expect([...(auth?.tenant?.permissions ?? [])].sort()).toEqual([...OWNER_PERMISSIONS].sort());
  });
});
