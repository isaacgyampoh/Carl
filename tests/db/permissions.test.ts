import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, PERMISSION_GROUPS, ROLE_TEMPLATES } from '@carl/domain';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';

/**
 * The permission catalogue exists in two places: TypeScript (`@carl/domain`) and the
 * `permissions` table. They must not drift.
 *
 * Drift here is not cosmetic. A permission checked in the UI but absent from the database
 * silently grants nothing; a permission granted in the database but unknown to TypeScript
 * is unreachable. Both fail quietly, which is the worst way for an authorization system
 * to fail. This test turns either into a build failure.
 */
describe('permission catalogue', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  it('contains exactly the permissions declared in @carl/domain', async () => {
    const { rows } = await db.query<{ key: string }>(`select key from permissions order by key`);
    const inDatabase = rows.map((r) => r.key).sort();
    // Widened to string[] so the two lists can be compared symmetrically.
    const inCode: string[] = [...ALL_PERMISSIONS].sort();

    const missingFromDatabase = inCode.filter((k) => !inDatabase.includes(k));
    const missingFromCode = inDatabase.filter((k) => !inCode.includes(k));

    expect(
      missingFromDatabase,
      'Declared in @carl/domain but not seeded. Run: node scripts/generate-permissions-migration.mjs',
    ).toEqual([]);
    expect(
      missingFromCode,
      'Seeded in the database but unknown to @carl/domain. Remove it or add it to the catalogue.',
    ).toEqual([]);
    expect(inDatabase).toEqual(inCode);
  });

  it('stores resource and action consistently with the key', async () => {
    const { rows } = await db.query<{ key: string; resource: string; action: string }>(
      `select key, resource, action from permissions`,
    );
    for (const row of rows) {
      expect(`${row.resource}.${row.action}`, `key ${row.key} disagrees with its parts`).toBe(
        row.key,
      );
    }
  });

  it('has no duplicate keys in the catalogue', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it('places every permission in exactly one UI group', () => {
    // A permission missing from every group is invisible in the role editor, so it can
    // never be granted through the UI even though the system checks it.
    const grouped = Object.values(PERMISSION_GROUPS).flat();
    const ungrouped = ALL_PERMISSIONS.filter((p) => !grouped.includes(p));
    expect(ungrouped, 'these permissions would be invisible in the role editor').toEqual([]);
    expect(new Set(grouped).size, 'a permission appears in more than one group').toBe(
      grouped.length,
    );
  });

  it('grants role templates only permissions that exist', async () => {
    const { rows } = await db.query<{ key: string }>(`select key from permissions`);
    const known = new Set(rows.map((r) => r.key));

    for (const template of ROLE_TEMPLATES) {
      for (const permission of template.permissions) {
        expect(known.has(permission), `role "${template.key}" grants unknown "${permission}"`).toBe(
          true,
        );
      }
    }
  });

  it('keeps the cashier role away from cost prices and refunds', () => {
    // Not a style preference. Cost prices expose the business's margins to every
    // temporary employee, and unilateral refunds are the most common till fraud.
    const cashier = ROLE_TEMPLATES.find((r) => r.key === 'cashier');
    expect(cashier).toBeDefined();
    expect(cashier!.permissions).not.toContain('products.view_cost');
    expect(cashier!.permissions).not.toContain('sales.refund');
    expect(cashier!.permissions).not.toContain('sales.discount');
    expect(cashier!.permissions).not.toContain('inventory.adjust');
    // But it must be able to do the job.
    expect(cashier!.permissions).toContain('sales.create');
    expect(cashier!.permissions).toContain('products.view');
  });

  it('keeps the accountant out of selling and stock movement', () => {
    const accountant = ROLE_TEMPLATES.find((r) => r.key === 'accountant');
    expect(accountant!.permissions).not.toContain('sales.create');
    expect(accountant!.permissions).not.toContain('inventory.adjust');
    expect(accountant!.permissions).toContain('reports.view_financial');
  });

  it('keeps the inventory manager away from sales revenue', () => {
    const inventory = ROLE_TEMPLATES.find((r) => r.key === 'inventory_manager');
    expect(inventory!.permissions).not.toContain('sales.view_all');
    expect(inventory!.permissions).not.toContain('reports.view_financial');
    expect(inventory!.permissions).toContain('inventory.adjust');
  });

  it('ranks roles so authority is comparable', () => {
    // Rank is what stops a manager granting a role above their own.
    const byKey = Object.fromEntries(ROLE_TEMPLATES.map((r) => [r.key, r.rank]));
    expect(byKey.tenant_owner).toBeLessThan(byKey.tenant_admin!);
    expect(byKey.tenant_admin).toBeLessThan(byKey.branch_manager!);
    expect(byKey.branch_manager).toBeLessThan(byKey.supervisor!);
    expect(byKey.supervisor).toBeLessThan(byKey.cashier!);
    expect(byKey.cashier).toBeLessThan(byKey.staff!);
  });
});
