/**
 * Fixtures that build real rows through real constraints.
 *
 * Deliberately not factories that bypass the schema. Every fixture inserts through the
 * same tables and triggers production uses, so a test that sets up a tenant also proves
 * a tenant can be set up.
 */

import type { TestDatabase } from './test-database.js';

export interface TenantFixture {
  tenantId: string;
  branchId: string;
  ownerUserId: string;
  ownerMembershipId: string;
  slug: string;
}

let counter = 0;
const nextSuffix = () => `${Date.now().toString(36)}${(counter += 1).toString(36)}`;

/** Creates an auth user and its profile. */
export async function createUser(
  db: TestDatabase,
  options: { email?: string; fullName?: string; isPlatformAdmin?: boolean } = {},
): Promise<string> {
  const suffix = nextSuffix();
  const email = options.email ?? `user-${suffix}@example.test`;

  const { rows } = await db.query<{ id: string }>(
    `insert into auth.users (email) values ($1) returning id`,
    [email],
  );
  const userId = rows[0]!.id;

  await db.query(
    `insert into profiles (id, email, full_name, is_platform_admin) values ($1, $2, $3, $4)`,
    [userId, email, options.fullName ?? `Test User ${suffix}`, options.isPlatformAdmin ?? false],
  );
  return userId;
}

/**
 * Creates a tenant with a default branch, an owner, and the system roles seeded.
 *
 * Runs as the service role because provisioning a tenant is, by definition, an operation
 * performed before the tenant's own members exist.
 */
export async function createTenant(
  db: TestDatabase,
  options: { name?: string; status?: string; ownerUserId?: string } = {},
): Promise<TenantFixture> {
  return db.asServiceRole(async () => {
    const suffix = nextSuffix();
    const slug = `tenant-${suffix}`;

    const tenant = await db.query<{ id: string }>(
      `insert into tenants (slug, name, status) values ($1, $2, $3::tenant_status) returning id`,
      [slug, options.name ?? `Test Business ${suffix}`, options.status ?? 'ACTIVE'],
    );
    const tenantId = tenant.rows[0]!.id;

    const branch = await db.query<{ id: string }>(
      `insert into branches (tenant_id, code, name, is_default) values ($1, 'main', 'Main Branch', true) returning id`,
      [tenantId],
    );
    const branchId = branch.rows[0]!.id;

    const ownerUserId = options.ownerUserId ?? (await createUser(db));

    const membership = await db.query<{ id: string }>(
      `insert into tenant_memberships (tenant_id, user_id, status, is_owner, accepted_at)
       values ($1, $2, 'ACTIVE', true, now()) returning id`,
      [tenantId, ownerUserId],
    );

    return {
      tenantId,
      branchId,
      ownerUserId,
      ownerMembershipId: membership.rows[0]!.id,
      slug,
    };
  });
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
