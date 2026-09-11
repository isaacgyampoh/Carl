import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { createUser } from '../support/fixtures.js';
import { createShop, type Shop } from '../support/pos.js';

/**
 * Server error records.
 *
 * They exist so the platform owner learns that Carl failed without waiting for a shop to
 * telephone. They are also the one table that holds text straight from a failure, so who may
 * read them matters: an error message can quote a price, a product or a customer, and the shops
 * whose data that is must not be able to read each other's — nor may anyone edit the record of
 * a failure after the fact.
 */
describe('server error records', () => {
  let db: TestDatabase;
  let owner: string;
  let shop: Shop;

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.reset();
    owner = await createUser(db, { isPlatformAdmin: true, scaffoldingPin: true });
    shop = await createShop(db);
    await db.asServiceRole(() =>
      db.query(
        `insert into app_errors (message, route, method, surface) values ('boom', '/pos', 'GET', 'business')`,
      ),
    );
  });

  it('are readable by the platform owner', async () => {
    const { rows } = await db.asUser(owner, () =>
      db.query<{ message: string }>(`select message from app_errors`),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toBe('boom');
  });

  it("are invisible to a business's own owner", async () => {
    const { rows } = await db.asUser(shop.ownerUserId, () => db.query(`select * from app_errors`));
    expect(rows).toHaveLength(0);
  });

  it('are refused outright to a signed-out caller', async () => {
    // anon holds no privilege on the table at all, so this fails before RLS is consulted.
    await expect(db.asAnon(() => db.query(`select * from app_errors`))).rejects.toThrow(
      /permission denied/,
    );
  });

  it('cannot be written, edited or deleted through a session', async () => {
    for (const [what, sql] of [
      ['insert', `insert into app_errors (message) values ('forged')`],
      ['update', `update app_errors set message = 'rewritten'`],
      ['delete', `delete from app_errors`],
    ] as const) {
      await expect(
        db.asUser(owner, () => db.query(sql)),
        `${what} was allowed`,
      ).rejects.toThrow();
    }
    const { rows } = await db.asServiceRole(() =>
      db.query<{ message: string }>(`select message from app_errors`),
    );
    expect(rows.map((r) => r.message)).toEqual(['boom']);
  });

  it('refuse a message that is empty or absurdly long', async () => {
    for (const message of ['', 'x'.repeat(2001)]) {
      await expect(
        db.asServiceRole(() => db.query(`insert into app_errors (message) values ($1)`, [message])),
      ).rejects.toThrow(/app_errors_message_bounded/);
    }
  });

  it('are pruned after thirty days, by the platform owner only', async () => {
    await db.asServiceRole(() =>
      db.query(
        `insert into app_errors (message, occurred_at) values ('ancient', now() - interval '31 days')`,
      ),
    );

    await expect(
      db.asUser(shop.ownerUserId, () => db.query(`select prune_app_errors()`)),
    ).rejects.toThrow(/PERMISSION_DENIED/);

    const { rows } = await db.asUser(owner, () =>
      db.query<{ prune_app_errors: number }>(`select prune_app_errors()`),
    );
    expect(rows[0]?.prune_app_errors).toBe(1);

    const left = await db.asServiceRole(() =>
      db.query<{ message: string }>(`select message from app_errors`),
    );
    expect(left.rows.map((r) => r.message)).toEqual(['boom']);
  });

  it('keep the record when the business they name is removed', async () => {
    /*
     * A reference to a business must neither stop that business being deleted nor take the
     * record of what went wrong with it. Asserted on the constraint itself: deleting a tenant
     * goes through the platform's own removal path, which suspends the immutability guards.
     */
    const { rows } = await db.asServiceRole(() =>
      db.query<{ confdeltype: string }>(
        `select confdeltype from pg_constraint
          where conrelid = 'public.app_errors'::regclass and confrelid = 'public.tenants'::regclass`,
      ),
    );
    // 'n' is ON DELETE SET NULL; 'c' would take the error record with the business.
    expect(rows[0]?.confdeltype).toBe('n');
  });
});
