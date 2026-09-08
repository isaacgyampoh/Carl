import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { createBranch, createProduct, createTenant } from '../support/fixtures.js';

/**
 * The inventory ledger is the source of truth; `inventory.quantity` is a cached total kept
 * alongside it so the till can answer "is there stock" with one indexed read.
 *
 * That redundancy is only safe if the two provably agree. These tests assert the
 * reconciliation identity that every stock-changing operation must preserve:
 *
 *     inventory.quantity == sum(inventory_movements.quantity)
 *
 * Phase 4 adds the transactional functions that maintain both. The identity is asserted
 * here first, so those functions have a standing test to satisfy rather than one written
 * afterwards to fit whatever they happened to do.
 */
describe('inventory ledger', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.reset();
  });

  /** Posts a movement and updates the cached total, as the Phase 4 functions will. */
  async function postMovement(
    tenantId: string,
    branchId: string,
    productId: string,
    type: string,
    quantity: number,
    occurredAt?: string,
  ): Promise<void> {
    await db.asServiceRole(async () => {
      await db.query(
        `insert into inventory (tenant_id, branch_id, product_id, quantity)
         values ($1, $2, $3, 0)
         on conflict (branch_id, product_id) do nothing`,
        [tenantId, branchId, productId],
      );

      const updated = await db.query<{ quantity: string }>(
        `update inventory set quantity = quantity + $3, last_movement_at = now()
         where branch_id = $1 and product_id = $2
         returning quantity`,
        [branchId, productId, quantity],
      );

      await db.query(
        `insert into inventory_movements
           (tenant_id, branch_id, product_id, movement_type, quantity, balance_after, occurred_at)
         values ($1, $2, $3, $4::movement_type, $5, $6, coalesce($7::timestamptz, now()))`,
        [
          tenantId,
          branchId,
          productId,
          type,
          quantity,
          updated.rows[0]!.quantity,
          occurredAt ?? null,
        ],
      );
    });
  }

  async function reconcile(
    branchId: string,
    productId: string,
  ): Promise<{ cached: number; ledger: number }> {
    const { rows } = await db.asServiceRole(() =>
      db.query<{ cached: string; ledger: string }>(
        `select
           (select quantity from inventory where branch_id = $1 and product_id = $2) as cached,
           (select coalesce(sum(quantity), 0) from inventory_movements
              where branch_id = $1 and product_id = $2) as ledger`,
        [branchId, productId],
      ),
    );
    return { cached: Number(rows[0]!.cached), ledger: Number(rows[0]!.ledger) };
  }

  it('keeps the cached quantity equal to the sum of the ledger', async () => {
    const t = await createTenant(db);
    const product = await createProduct(db, t.tenantId);

    await postMovement(t.tenantId, t.branchId, product, 'OPENING_STOCK', 100);
    await postMovement(t.tenantId, t.branchId, product, 'SALE', -3);
    await postMovement(t.tenantId, t.branchId, product, 'SALE', -7);
    await postMovement(t.tenantId, t.branchId, product, 'PURCHASE', 50);
    await postMovement(t.tenantId, t.branchId, product, 'SALE_RETURN', 2);
    await postMovement(t.tenantId, t.branchId, product, 'DAMAGE', -5);

    const { cached, ledger } = await reconcile(t.branchId, product);
    expect(cached).toBe(137); // 100 - 3 - 7 + 50 + 2 - 5
    expect(cached, 'cached total has drifted from the ledger').toBe(ledger);
  });

  it('records a running balance that matches the ledger at every point', async () => {
    // balance_after is what makes "what was stock on 3 March" answerable without
    // replaying history. If it drifts, the stock card lies.
    const t = await createTenant(db);
    const product = await createProduct(db, t.tenantId);

    await postMovement(t.tenantId, t.branchId, product, 'OPENING_STOCK', 20);
    await postMovement(t.tenantId, t.branchId, product, 'SALE', -5);
    await postMovement(t.tenantId, t.branchId, product, 'PURCHASE', 10);

    const { rows } = await db.asServiceRole(() =>
      db.query<{ quantity: string; balance_after: string; running: string }>(
        `select quantity, balance_after,
                sum(quantity) over (order by occurred_at, id) as running
         from inventory_movements
         where branch_id = $1 and product_id = $2
         order by occurred_at, id`,
        [t.branchId, product],
      ),
    );

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(Number(row.balance_after)).toBe(Number(row.running));
    }
    expect(rows.map((r) => Number(r.balance_after))).toEqual([20, 15, 25]);
  });

  it('keeps branch stock genuinely separate', async () => {
    // A sale in Accra must not touch Kumasi. The unique index is on (branch, product),
    // so this is a structural guarantee rather than a convention.
    const t = await createTenant(db);
    const kumasi = await createBranch(db, t.tenantId, 'kumasi');
    const product = await createProduct(db, t.tenantId);

    await postMovement(t.tenantId, t.branchId, product, 'OPENING_STOCK', 100);
    await postMovement(t.tenantId, kumasi, product, 'OPENING_STOCK', 45);
    await postMovement(t.tenantId, t.branchId, product, 'SALE', -10);

    expect((await reconcile(t.branchId, product)).cached).toBe(90);
    expect((await reconcile(kumasi, product)).cached).toBe(45);

    const kumasiLedger = await reconcile(kumasi, product);
    expect(kumasiLedger.cached).toBe(kumasiLedger.ledger);
  });

  it('handles fractional quantities exactly', async () => {
    // Weighed goods. numeric(14,3) is exact; a float column would drift here.
    const t = await createTenant(db);
    const product = await createProduct(db, t.tenantId);

    await postMovement(t.tenantId, t.branchId, product, 'OPENING_STOCK', 10);
    for (let i = 0; i < 30; i += 1) {
      await postMovement(t.tenantId, t.branchId, product, 'SALE', -0.1);
    }

    const { cached, ledger } = await reconcile(t.branchId, product);
    expect(cached).toBe(7);
    expect(cached).toBe(ledger);
  });

  it('reconstructs stock at a past moment from the ledger alone', async () => {
    // The reason a ledger exists: when the count is wrong, the history explains it.
    const t = await createTenant(db);
    const product = await createProduct(db, t.tenantId);

    // Backdated at insert time, not by editing: the ledger refuses updates, and this
    // test would be lying if it worked around that.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await postMovement(t.tenantId, t.branchId, product, 'OPENING_STOCK', 100, tenDaysAgo);
    await postMovement(t.tenantId, t.branchId, product, 'SALE', -40);

    const { rows } = await db.asServiceRole(() =>
      db.query<{ as_of: string }>(
        `select coalesce(sum(quantity), 0) as as_of
         from inventory_movements
         where product_id = $1 and occurred_at <= now() - interval '1 day'`,
        [product],
      ),
    );
    expect(Number(rows[0]!.as_of)).toBe(100);
    expect((await reconcile(t.branchId, product)).cached).toBe(60);
  });
});
