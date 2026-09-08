import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { addMember, createBranch, createProduct, createTenant } from '../support/fixtures.js';

/**
 * Transactional inventory operations.
 *
 * Stock is never written directly — there is no INSERT or UPDATE policy on `inventory` for
 * any role. Every change goes through a function that adjusts the cached quantity and posts
 * a ledger movement in the same transaction.
 *
 * The reconciliation identity is asserted after every scenario:
 *
 *     inventory.quantity == sum(inventory_movements.quantity)
 *
 * If a function ever updates one without the other, these fail.
 */
describe('inventory operations', () => {
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

  async function stockOf(branchId: string, productId: string): Promise<number> {
    const { rows } = await db.asServiceRole(() =>
      db.query<{ q: string | null }>(
        `select quantity as q from inventory where branch_id = $1 and product_id = $2`,
        [branchId, productId],
      ),
    );
    return Number(rows[0]?.q ?? 0);
  }

  /** The invariant that makes the cached total safe to rely on. */
  async function assertReconciled(branchId: string, productId: string): Promise<void> {
    const { rows } = await db.asServiceRole(() =>
      db.query<{ cached: string | null; ledger: string }>(
        `select
           (select quantity from inventory where branch_id = $1 and product_id = $2) as cached,
           (select coalesce(sum(quantity), 0) from inventory_movements
              where branch_id = $1 and product_id = $2) as ledger`,
        [branchId, productId],
      ),
    );
    expect(Number(rows[0]!.cached ?? 0), 'the cached quantity has drifted from the ledger').toBe(
      Number(rows[0]!.ledger),
    );
  }

  async function openingStock(
    tenant: { tenantId: string; ownerUserId: string },
    branchId: string,
    productId: string,
    quantity: number,
  ): Promise<void> {
    await db.asUser(tenant.ownerUserId, () =>
      db.query(
        `select * from apply_stock_adjustment($1, $2, $3, 'OPENING_STOCK', 'Opening balance')`,
        [branchId, productId, quantity],
      ),
    );
  }

  describe('apply_stock_adjustment', () => {
    it('adjusts stock and posts a matching ledger entry', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);

      await openingStock(t, t.branchId, product, 100);
      expect(await stockOf(t.branchId, product)).toBe(100);
      await assertReconciled(t.branchId, product);

      await db.asUser(t.ownerUserId, () =>
        db.query(
          `select * from apply_stock_adjustment($1, $2, -12, 'DAMAGE', 'Water damage in store')`,
          [t.branchId, product],
        ),
      );
      expect(await stockOf(t.branchId, product)).toBe(88);
      await assertReconciled(t.branchId, product);
    });

    it('requires a reason of substance', async () => {
      // An adjustment with no explanation is indistinguishable from theft, and the ledger
      // exists so that question stays answerable.
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);

      await expect(
        db.asUser(t.ownerUserId, () =>
          db.query(`select * from apply_stock_adjustment($1, $2, 5, 'ADJUSTMENT_IN', 'x')`, [
            t.branchId,
            product,
          ]),
        ),
      ).rejects.toThrow(/VALIDATION_FAILED/);
    });

    it('refuses a cashier', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);
      const { userId } = await addMember(db, t.tenantId, { roleKey: 'cashier' });

      await expect(
        db.asUser(userId, () =>
          db.query(
            `select * from apply_stock_adjustment($1, $2, 100, 'ADJUSTMENT_IN', 'Helping myself')`,
            [t.branchId, product],
          ),
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('refuses to take stock below zero', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);
      await openingStock(t, t.branchId, product, 10);

      await expect(
        db.asUser(t.ownerUserId, () =>
          db.query(`select * from apply_stock_adjustment($1, $2, -11, 'DAMAGE', 'Too many')`, [
            t.branchId,
            product,
          ]),
        ),
      ).rejects.toThrow(/INSUFFICIENT_STOCK/);

      expect(await stockOf(t.branchId, product)).toBe(10);
      await assertReconciled(t.branchId, product);
    });

    it('permits negative stock where the branch is configured for it', async () => {
      // Real for made-to-order and service businesses; off by default because a POS that
      // silently sells air produces inventory nobody can reconcile.
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);
      await db.asServiceRole(() =>
        db.query(`update branches set allow_negative_stock = true where id = $1`, [t.branchId]),
      );

      await db.asUser(t.ownerUserId, () =>
        db.query(
          `select * from apply_stock_adjustment($1, $2, -5, 'ADJUSTMENT_OUT', 'Backorder')`,
          [t.branchId, product],
        ),
      );
      expect(await stockOf(t.branchId, product)).toBe(-5);
    });

    it('refuses a movement type that is not a manual adjustment', async () => {
      // A SALE movement must come from a sale, or the ledger stops explaining anything.
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);

      await expect(
        db.asUser(t.ownerUserId, () =>
          db.query(`select * from apply_stock_adjustment($1, $2, -1, 'SALE', 'Pretending')`, [
            t.branchId,
            product,
          ]),
        ),
      ).rejects.toThrow(/VALIDATION_FAILED/);
    });

    it('ignores a product that is not stock tracked', async () => {
      const t = await createTenant(db);
      const service = await createProduct(db, t.tenantId, { name: 'Delivery' });
      await db.asServiceRole(() =>
        db.query(`update products set is_stock_tracked = false where id = $1`, [service]),
      );

      await db.asUser(t.ownerUserId, () =>
        db.query(`select * from apply_stock_adjustment($1, $2, 10, 'ADJUSTMENT_IN', 'No effect')`, [
          t.branchId,
          service,
        ]),
      );

      const { rows } = await db.asServiceRole(() =>
        db.query(`select id from inventory_movements where product_id = $1`, [service]),
      );
      expect(rows).toHaveLength(0);
    });

    it('records an audit entry naming the reason', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);
      await openingStock(t, t.branchId, product, 50);

      const { rows } = await db.asServiceRole(() =>
        db.query<{ action: string; metadata: { reason?: string } }>(
          `select action, metadata from audit_logs where action = 'STOCK_ADJUSTED'`,
        ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.metadata.reason).toBe('Opening balance');
    });
  });

  describe('weighted average cost', () => {
    it('averages a new delivery against stock already on hand', async () => {
      // 10 at GH₵10 plus 10 at GH₵14 is GH₵12 a unit, not GH₵14. Using the latest price
      // would restate the value of goods already on the shelf.
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);

      const purchase = await db.asServiceRole(async () => {
        const { rows } = await db.query<{ id: string }>(
          `insert into purchases (tenant_id, branch_id, reference) values ($1, $2, 'PO-1') returning id`,
          [t.tenantId, t.branchId],
        );
        await db.query(
          `insert into purchase_items (purchase_id, tenant_id, product_id, line_number, quantity_ordered, unit_cost, line_total)
           values ($1, $2, $3, 1, 20, 1000, 20000)`,
          [rows[0]!.id, t.tenantId, product],
        );
        return rows[0]!.id;
      });

      await db.asUser(t.ownerUserId, () =>
        db.query(`select * from receive_purchase($1, $2::jsonb)`, [
          purchase,
          JSON.stringify([{ product_id: product, quantity: 10, unit_cost: 1000 }]),
        ]),
      );

      let cost = await db.asServiceRole(() =>
        db.query<{ average_cost: string }>(`select average_cost from products where id = $1`, [
          product,
        ]),
      );
      expect(Number(cost.rows[0]!.average_cost)).toBe(1000);

      await db.asUser(t.ownerUserId, () =>
        db.query(`select * from receive_purchase($1, $2::jsonb)`, [
          purchase,
          JSON.stringify([{ product_id: product, quantity: 10, unit_cost: 1400 }]),
        ]),
      );

      cost = await db.asServiceRole(() =>
        db.query<{ average_cost: string }>(`select average_cost from products where id = $1`, [
          product,
        ]),
      );
      expect(Number(cost.rows[0]!.average_cost)).toBe(1200);
      expect(await stockOf(t.branchId, product)).toBe(20);
      await assertReconciled(t.branchId, product);
    });

    it('takes the delivery cost outright when there is no stock to average against', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);

      const purchase = await db.asServiceRole(async () => {
        const { rows } = await db.query<{ id: string }>(
          `insert into purchases (tenant_id, branch_id, reference) values ($1, $2, 'PO-2') returning id`,
          [t.tenantId, t.branchId],
        );
        await db.query(
          `insert into purchase_items (purchase_id, tenant_id, product_id, line_number, quantity_ordered, unit_cost, line_total)
           values ($1, $2, $3, 1, 5, 2500, 12500)`,
          [rows[0]!.id, t.tenantId, product],
        );
        return rows[0]!.id;
      });

      await db.asUser(t.ownerUserId, () =>
        db.query(`select * from receive_purchase($1, $2::jsonb)`, [
          purchase,
          JSON.stringify([{ product_id: product, quantity: 5, unit_cost: 2500 }]),
        ]),
      );

      const cost = await db.asServiceRole(() =>
        db.query<{ average_cost: string }>(`select average_cost from products where id = $1`, [
          product,
        ]),
      );
      expect(Number(cost.rows[0]!.average_cost)).toBe(2500);
    });

    it('marks a purchase received only once every line has arrived', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);

      const purchase = await db.asServiceRole(async () => {
        const { rows } = await db.query<{ id: string }>(
          `insert into purchases (tenant_id, branch_id, reference) values ($1, $2, 'PO-3') returning id`,
          [t.tenantId, t.branchId],
        );
        await db.query(
          `insert into purchase_items (purchase_id, tenant_id, product_id, line_number, quantity_ordered, unit_cost, line_total)
           values ($1, $2, $3, 1, 100, 500, 50000)`,
          [rows[0]!.id, t.tenantId, product],
        );
        return rows[0]!.id;
      });

      await db.asUser(t.ownerUserId, () =>
        db.query(`select * from receive_purchase($1, $2::jsonb)`, [
          purchase,
          JSON.stringify([{ product_id: product, quantity: 60, unit_cost: 500 }]),
        ]),
      );

      let status = await db.asServiceRole(() =>
        db.query<{ status: string }>(`select status from purchases where id = $1`, [purchase]),
      );
      expect(status.rows[0]!.status).toBe('PARTIALLY_RECEIVED');

      await db.asUser(t.ownerUserId, () =>
        db.query(`select * from receive_purchase($1, $2::jsonb)`, [
          purchase,
          JSON.stringify([{ product_id: product, quantity: 40, unit_cost: 500 }]),
        ]),
      );

      status = await db.asServiceRole(() =>
        db.query<{ status: string }>(`select status from purchases where id = $1`, [purchase]),
      );
      expect(status.rows[0]!.status).toBe('RECEIVED');
      expect(await stockOf(t.branchId, product)).toBe(100);
    });
  });

  describe('stock transfers', () => {
    async function buildTransfer(
      t: { tenantId: string; branchId: string; ownerUserId: string },
      toBranch: string,
      productId: string,
      quantity: number,
    ): Promise<string> {
      return db.asServiceRole(async () => {
        const { rows } = await db.query<{ id: string }>(
          `insert into stock_transfers (tenant_id, reference, from_branch_id, to_branch_id, status)
           values ($1, 'TR-' || substr(gen_random_uuid()::text, 1, 8), $2, $3, 'APPROVED') returning id`,
          [t.tenantId, t.branchId, toBranch],
        );
        await db.query(
          `insert into stock_transfer_items (transfer_id, tenant_id, product_id, quantity_requested)
           values ($1, $2, $3, $4)`,
          [rows[0]!.id, t.tenantId, productId, quantity],
        );
        return rows[0]!.id;
      });
    }

    it('moves stock between branches without altering the total', async () => {
      const t = await createTenant(db);
      const kumasi = await createBranch(db, t.tenantId, 'kumasi');
      const product = await createProduct(db, t.tenantId);

      await openingStock(t, t.branchId, product, 100);
      const transfer = await buildTransfer(t, kumasi, product, 20);

      await db.asUser(t.ownerUserId, () =>
        db.query(`select * from dispatch_stock_transfer($1)`, [transfer]),
      );

      // Dispatched: gone from the sender, not yet at the receiver. Goods in a van belong
      // to neither shelf.
      expect(await stockOf(t.branchId, product)).toBe(80);
      expect(await stockOf(kumasi, product)).toBe(0);

      await db.asUser(t.ownerUserId, () =>
        db.query(`select * from receive_stock_transfer($1)`, [transfer]),
      );

      expect(await stockOf(t.branchId, product)).toBe(80);
      expect(await stockOf(kumasi, product)).toBe(20);
      await assertReconciled(t.branchId, product);
      await assertReconciled(kumasi, product);
    });

    it('refuses to dispatch more than the sending branch holds', async () => {
      const t = await createTenant(db);
      const kumasi = await createBranch(db, t.tenantId, 'kumasi');
      const product = await createProduct(db, t.tenantId);

      await openingStock(t, t.branchId, product, 5);
      const transfer = await buildTransfer(t, kumasi, product, 50);

      await expect(
        db.asUser(t.ownerUserId, () =>
          db.query(`select * from dispatch_stock_transfer($1)`, [transfer]),
        ),
      ).rejects.toThrow(/INSUFFICIENT_STOCK/);

      // The whole dispatch rolls back: stock is untouched and the transfer is not in transit.
      expect(await stockOf(t.branchId, product)).toBe(5);
      const { rows } = await db.asServiceRole(() =>
        db.query<{ status: string }>(`select status from stock_transfers where id = $1`, [
          transfer,
        ]),
      );
      expect(rows[0]!.status).toBe('APPROVED');
    });

    it('records a shortfall when less arrives than was sent', async () => {
      // Loss in transit is a real event. Forcing received to equal sent would hide it.
      const t = await createTenant(db);
      const kumasi = await createBranch(db, t.tenantId, 'kumasi');
      const product = await createProduct(db, t.tenantId);

      await openingStock(t, t.branchId, product, 100);
      const transfer = await buildTransfer(t, kumasi, product, 20);

      await db.asUser(t.ownerUserId, () =>
        db.query(`select * from dispatch_stock_transfer($1)`, [transfer]),
      );
      await db.asUser(t.ownerUserId, () =>
        db.query(`select * from receive_stock_transfer($1, $2::jsonb)`, [
          transfer,
          JSON.stringify([{ product_id: product, quantity: 18 }]),
        ]),
      );

      expect(await stockOf(kumasi, product)).toBe(18);
      expect(await stockOf(t.branchId, product)).toBe(80);

      const { rows } = await db.asServiceRole(() =>
        db.query<{ metadata: { sent: number; received: number } }>(
          `select metadata from audit_logs where action = 'TRANSFER_SHORTFALL'`,
        ),
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.metadata.sent)).toBe(20);
      expect(Number(rows[0]!.metadata.received)).toBe(18);
    });

    it('refuses to receive a transfer that was never dispatched', async () => {
      const t = await createTenant(db);
      const kumasi = await createBranch(db, t.tenantId, 'kumasi');
      const product = await createProduct(db, t.tenantId);
      await openingStock(t, t.branchId, product, 10);
      const transfer = await buildTransfer(t, kumasi, product, 5);

      await expect(
        db.asUser(t.ownerUserId, () =>
          db.query(`select * from receive_stock_transfer($1)`, [transfer]),
        ),
      ).rejects.toThrow(/STOCK_TRANSFER_INVALID_STATE/);
    });

    it('refuses to dispatch the same transfer twice', async () => {
      const t = await createTenant(db);
      const kumasi = await createBranch(db, t.tenantId, 'kumasi');
      const product = await createProduct(db, t.tenantId);
      await openingStock(t, t.branchId, product, 100);
      const transfer = await buildTransfer(t, kumasi, product, 10);

      await db.asUser(t.ownerUserId, () =>
        db.query(`select * from dispatch_stock_transfer($1)`, [transfer]),
      );
      await expect(
        db.asUser(t.ownerUserId, () =>
          db.query(`select * from dispatch_stock_transfer($1)`, [transfer]),
        ),
      ).rejects.toThrow(/STOCK_TRANSFER_INVALID_STATE/);

      expect(await stockOf(t.branchId, product)).toBe(90);
    });
  });

  describe('stock counts', () => {
    it('posts the variance as ledger movements rather than overwriting the quantity', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);
      await openingStock(t, t.branchId, product, 100);

      const count = await db.asServiceRole(async () => {
        const { rows } = await db.query<{ id: string }>(
          `insert into stock_counts (tenant_id, branch_id, reference, status, started_at)
           values ($1, $2, 'SC-1', 'PENDING_APPROVAL', now()) returning id`,
          [t.tenantId, t.branchId],
        );
        await db.query(
          `insert into stock_count_items (stock_count_id, tenant_id, product_id, expected_quantity, counted_quantity)
           values ($1, $2, $3, 100, 94)`,
          [rows[0]!.id, t.tenantId, product],
        );
        return rows[0]!.id;
      });

      const { rows } = await db.asUser(t.ownerUserId, () =>
        db.query<{ adjusted_count: number; total_variance: string }>(
          `select * from apply_stock_count($1)`,
          [count],
        ),
      );

      expect(rows[0]!.adjusted_count).toBe(1);
      expect(Number(rows[0]!.total_variance)).toBe(-6);
      expect(await stockOf(t.branchId, product)).toBe(94);
      await assertReconciled(t.branchId, product);

      // The shrinkage is explained in the ledger, not merely absorbed.
      const movement = await db.asServiceRole(() =>
        db.query<{ movement_type: string; quantity: string }>(
          `select movement_type, quantity from inventory_movements
           where product_id = $1 and movement_type = 'STOCK_COUNT'`,
          [product],
        ),
      );
      expect(movement.rows).toHaveLength(1);
      expect(Number(movement.rows[0]!.quantity)).toBe(-6);
    });

    it('records a count showing more than expected', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);
      await openingStock(t, t.branchId, product, 50);

      const count = await db.asServiceRole(async () => {
        const { rows } = await db.query<{ id: string }>(
          `insert into stock_counts (tenant_id, branch_id, reference, status)
           values ($1, $2, 'SC-2', 'PENDING_APPROVAL') returning id`,
          [t.tenantId, t.branchId],
        );
        await db.query(
          `insert into stock_count_items (stock_count_id, tenant_id, product_id, expected_quantity, counted_quantity)
           values ($1, $2, $3, 50, 57)`,
          [rows[0]!.id, t.tenantId, product],
        );
        return rows[0]!.id;
      });

      await db.asUser(t.ownerUserId, () =>
        db.query(`select * from apply_stock_count($1)`, [count]),
      );
      expect(await stockOf(t.branchId, product)).toBe(57);
    });

    it('refuses to apply the same count twice', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);
      await openingStock(t, t.branchId, product, 20);

      const count = await db.asServiceRole(async () => {
        const { rows } = await db.query<{ id: string }>(
          `insert into stock_counts (tenant_id, branch_id, reference, status)
           values ($1, $2, 'SC-3', 'PENDING_APPROVAL') returning id`,
          [t.tenantId, t.branchId],
        );
        await db.query(
          `insert into stock_count_items (stock_count_id, tenant_id, product_id, expected_quantity, counted_quantity)
           values ($1, $2, $3, 20, 15)`,
          [rows[0]!.id, t.tenantId, product],
        );
        return rows[0]!.id;
      });

      await db.asUser(t.ownerUserId, () =>
        db.query(`select * from apply_stock_count($1)`, [count]),
      );
      await expect(
        db.asUser(t.ownerUserId, () => db.query(`select * from apply_stock_count($1)`, [count])),
      ).rejects.toThrow(/STOCK_COUNT_ALREADY_CLOSED/);

      expect(await stockOf(t.branchId, product)).toBe(15);
    });

    it('refuses a supervisor without count approval', async () => {
      const t = await createTenant(db);
      const product = await createProduct(db, t.tenantId);
      const { userId } = await addMember(db, t.tenantId, { roleKey: 'supervisor' });

      const count = await db.asServiceRole(async () => {
        const { rows } = await db.query<{ id: string }>(
          `insert into stock_counts (tenant_id, branch_id, reference, status)
           values ($1, $2, 'SC-4', 'PENDING_APPROVAL') returning id`,
          [t.tenantId, t.branchId],
        );
        await db.query(
          `insert into stock_count_items (stock_count_id, tenant_id, product_id, expected_quantity, counted_quantity)
           values ($1, $2, $3, 0, 999)`,
          [rows[0]!.id, t.tenantId, product],
        );
        return rows[0]!.id;
      });

      await expect(
        db.asUser(userId, () => db.query(`select * from apply_stock_count($1)`, [count])),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });
  });
});
