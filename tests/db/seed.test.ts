import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';

const SEED = join(dirname(fileURLToPath(import.meta.url)), '../../supabase/seed/seed.sql');

/**
 * Development seed data.
 *
 * A seed nobody runs in CI is a seed that has been broken for weeks. These tests load the
 * real file into a real migrated database, so a schema change that invalidates it fails
 * here rather than on a new developer's first afternoon.
 */
describe('seed data', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await db.exec(await readFile(SEED, 'utf8'));
  });

  afterAll(async () => {
    await db?.close();
  });

  it('creates two businesses, so tenant isolation is visible while developing', async () => {
    const { rows } = await db.asServiceRole(() =>
      db.query<{ slug: string }>(`select slug from tenants order by slug`),
    );
    expect(rows.map((r) => r.slug)).toEqual(['demo-trading', 'other-shop']);
  });

  it('provisions the demo tenant through the real function, with system roles', async () => {
    // Seeding by hand-inserting rows would produce a tenant shaped unlike any real one —
    // typically with no roles, so every permission test against it passes vacuously.
    const { rows } = await db.asServiceRole(() =>
      db.query<{ n: number }>(
        `select count(*)::int as n from roles r
         join tenants t on t.id = r.tenant_id
         where t.slug = 'demo-trading' and r.is_system`,
      ),
    );
    expect(rows[0]!.n).toBe(8);
  });

  it('gives the demo business three branches and stocked products', async () => {
    const { rows } = await db.asServiceRole(() =>
      db.query<{ branches: number; products: number; stocked: number }>(
        `select
           (select count(*)::int from branches b join tenants t on t.id = b.tenant_id
             where t.slug = 'demo-trading') as branches,
           (select count(*)::int from products p join tenants t on t.id = p.tenant_id
             where t.slug = 'demo-trading') as products,
           (select count(*)::int from inventory i join tenants t on t.id = i.tenant_id
             where t.slug = 'demo-trading' and i.quantity > 0) as stocked`,
      ),
    );
    expect(rows[0]!.branches).toBe(3);
    expect(rows[0]!.products).toBe(10);
    expect(rows[0]!.stocked).toBe(10);
  });

  it('leaves the ledger reconciled with the stock it seeded', async () => {
    // Seeding stock by writing `inventory` without a matching movement would start every
    // developer's database in the exact state the ledger exists to prevent.
    const { rows } = await db.asServiceRole(() =>
      db.query<{ drifted: number }>(
        `select count(*)::int as drifted
         from inventory i
         where i.quantity <> coalesce((
           select sum(m.quantity) from inventory_movements m
           where m.branch_id = i.branch_id and m.product_id = i.product_id
         ), 0)`,
      ),
    );
    expect(rows[0]!.drifted, 'seeded stock does not match the ledger').toBe(0);
  });

  it('confines the cashier to one branch', async () => {
    const cashier = '00000000-0000-4000-8000-00000000000d';
    const { rows } = await db.asUser(cashier, () =>
      db.query<{ code: string }>(`select code from branches order by code`),
    );
    expect(rows.map((r) => r.code)).toEqual(['accra']);
  });

  it('keeps the two seeded businesses invisible to each other', async () => {
    const demoOwner = '00000000-0000-4000-8000-00000000000b';
    const { rows } = await db.asUser(demoOwner, () =>
      db.query<{ name: string }>(`select name from products where sku = 'SECRET-1'`),
    );
    expect(rows, 'the second business leaked into the first').toHaveLength(0);
  });

  it('makes the seeded platform admin an administrator, and nothing more', async () => {
    const admin = '00000000-0000-4000-8000-00000000000a';

    const tenants = await db.asUser(admin, () => db.query(`select id from tenants`));
    expect(tenants.rows.length).toBeGreaterThan(0);

    // Platform administration does not confer access to a customer's trading data.
    const products = await db.asUser(admin, () => db.query(`select id from products`));
    expect(products.rows, 'a platform admin could read tenant products').toHaveLength(0);
  });

  it('leaves a terminal awaiting activation, so the flow can be exercised', async () => {
    const { rows } = await db.asServiceRole(() =>
      db.query<{ status: string }>(`select status from devices order by code`),
    );
    expect(rows.map((r) => r.status)).toEqual(['PENDING', 'PENDING']);
  });

  it('refuses to run against a database that already has tenants', async () => {
    // The likeliest accident is running this against the wrong project. The guard makes
    // that an error rather than a set of working logins whose passwords are public.
    await expect(db.exec(await readFile(SEED, 'utf8'))).rejects.toThrow(/REFUSING_TO_SEED/);
  });
});
