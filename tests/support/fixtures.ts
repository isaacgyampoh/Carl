/**
 * Fixtures that build real rows through real constraints.
 *
 * Deliberately not factories that bypass the schema. Every fixture inserts through the
 * same tables and triggers production uses, so a test that sets up a tenant also proves
 * a tenant can be set up.
 */

import { randomUUID } from 'node:crypto';

import type { TestDatabase } from './test-database.js';

export interface TenantFixture {
  tenantId: string;
  branchId: string;
  ownerUserId: string;
  ownerMembershipId: string;
  slug: string;
}

/**
 * A suffix unique across the whole suite.
 *
 * The counter alone is not enough: it lives at module scope, and each test file gets its
 * own module instance, so two files can produce the same counter in the same millisecond
 * and collide on a unique index such as `tenants.slug`. The random component removes that
 * — a rare, hard-to-reproduce failure is worse than an obvious one.
 */
let counter = 0;
const nextSuffix = () =>
  `${Date.now().toString(36)}${(counter += 1).toString(36)}${randomUUID().slice(0, 6)}`;

/** Creates an auth user and its profile. */
export async function createUser(
  db: TestDatabase,
  options: { email?: string; fullName?: string; isPlatformAdmin?: boolean } = {},
): Promise<string> {
  const suffix = nextSuffix();
  const email = options.email ?? `user-${suffix}@example.test`;

  // Creating an account is not a tenant operation. On real Supabase `auth.users` is owned
  // by `supabase_auth_admin` and accounts come from the Auth admin API — `service_role`
  // has no privileges on it. `asAdmin` stands in for that, and works whether or not the
  // caller is already inside an identity block.
  //
  // The id is supplied rather than defaulted, because real Supabase has no default on
  // `auth.users.id`; GoTrue provides it.
  const userId = randomUUID();

  await db.asAdmin(async () => {
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [userId, email]);
    await db.query(`insert into profiles (id, email, full_name) values ($1, $2, $3)`, [
      userId,
      email,
      options.fullName ?? `Test User ${suffix}`,
    ]);
    if (options.isPlatformAdmin) {
      await db.query(`insert into platform_admins (user_id) values ($1)`, [userId]);
    }
  });

  return userId;
}

/**
 * Creates a tenant with a default branch, an owner, and the system roles seeded.
 *
 * Runs as the service role because provisioning a tenant is, by definition, an operation
 * performed before the tenant's own members exist.
 */
/**
 * Creates a tenant through the real `provision_tenant()` function.
 *
 * Deliberately not hand-inserted rows: provisioning is what production does, so a fixture
 * that bypasses it would leave tests running against a tenant shaped differently from any
 * real one — with no system roles, and therefore no permissions to test against.
 */
export async function createTenant(
  db: TestDatabase,
  options: { name?: string; status?: string; ownerUserId?: string } = {},
): Promise<TenantFixture> {
  const suffix = nextSuffix();
  const slug = `tenant-${suffix}`;
  const ownerUserId = options.ownerUserId ?? (await createUser(db));

  const owner = await db.asServiceRole(() =>
    db.query<{ email: string; full_name: string }>(
      `select email::text as email, full_name from profiles where id = $1`,
      [ownerUserId],
    ),
  );

  // Provisioning requires a platform administrator; the harness supplies one.
  const platformAdmin = await createUser(db, { isPlatformAdmin: true });

  const result = await db.asUser(platformAdmin, () =>
    db.query<{ tenant_id: string; branch_id: string; membership_id: string }>(
      `select * from provision_tenant($1, $2, $3, $4, $5, 'Main Branch', 'main', $6::tenant_status, 14)`,
      [
        slug,
        options.name ?? `Test Business ${suffix}`,
        owner.rows[0]!.email,
        owner.rows[0]!.full_name,
        ownerUserId,
        options.status ?? 'ACTIVE',
      ],
    ),
  );

  const row = result.rows[0]!;
  return {
    tenantId: row.tenant_id,
    branchId: row.branch_id,
    ownerUserId,
    ownerMembershipId: row.membership_id,
    slug,
  };
}

export async function createBranch(
  db: TestDatabase,
  tenantId: string,
  code: string,
  name = code,
): Promise<string> {
  return db.asServiceRole(async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into branches (tenant_id, code, name) values ($1, $2, $3) returning id`,
      [tenantId, code, name],
    );
    return rows[0]!.id;
  });
}

export async function createProduct(
  db: TestDatabase,
  tenantId: string,
  options: { name?: string; sku?: string; retailPrice?: number } = {},
): Promise<string> {
  return db.asServiceRole(async () => {
    const suffix = nextSuffix().toUpperCase();
    const { rows } = await db.query<{ id: string }>(
      `insert into products (tenant_id, name, sku) values ($1, $2, $3) returning id`,
      [tenantId, options.name ?? `Product ${suffix}`, options.sku ?? `SKU-${suffix}`],
    );
    const productId = rows[0]!.id;

    if (options.retailPrice !== undefined) {
      await db.query(
        `insert into product_prices (tenant_id, product_id, tier, amount) values ($1, $2, 'RETAIL', $3)`,
        [tenantId, productId, options.retailPrice],
      );
    }
    return productId;
  });
}

/** Adds a member to a tenant and grants them a role. */
export async function addMember(
  db: TestDatabase,
  tenantId: string,
  options: { userId?: string; roleKey?: string; branchIds?: string[] } = {},
): Promise<{ userId: string; membershipId: string }> {
  return db.asServiceRole(async () => {
    const userId = options.userId ?? (await createUser(db));

    const membership = await db.query<{ id: string }>(
      `insert into tenant_memberships (tenant_id, user_id, status, accepted_at)
       values ($1, $2, 'ACTIVE', now()) returning id`,
      [tenantId, userId],
    );
    const membershipId = membership.rows[0]!.id;

    if (options.roleKey) {
      const role = await db.query<{ id: string }>(
        `select id from roles where tenant_id = $1 and key = $2`,
        [tenantId, options.roleKey],
      );
      if (role.rows[0]) {
        await db.query(`insert into membership_roles (membership_id, role_id) values ($1, $2)`, [
          membershipId,
          role.rows[0].id,
        ]);
      }
    }

    for (const branchId of options.branchIds ?? []) {
      await db.query(`insert into membership_branches (membership_id, branch_id) values ($1, $2)`, [
        membershipId,
        branchId,
      ]);
    }

    return { userId, membershipId };
  });
}
