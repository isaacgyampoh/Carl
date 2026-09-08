/**
 * Helpers for exercising the point of sale.
 *
 * Kept apart from the generic fixtures because a POS scenario needs a shop that is
 * actually ready to trade: products with prices, stock on the shelf, and a cashier who
 * holds the right permissions.
 */

import { randomUUID } from 'node:crypto';
import type { TestDatabase } from './test-database.js';
import { createProduct, createTenant, type TenantFixture } from './fixtures.js';

export interface Shop extends TenantFixture {
  /** Adds a product with a retail price and opening stock. */
  stock(options: {
    name?: string;
    price: number;
    quantity?: number;
    cost?: number;
    taxMode?: 'INCLUSIVE' | 'EXCLUSIVE' | 'EXEMPT';
    taxRate?: number;
    allowFractional?: boolean;
  }): Promise<string>;
}

/** A tenant with one branch, ready to sell. */
export async function createShop(db: TestDatabase): Promise<Shop> {
  const tenant = await createTenant(db);

  return {
    ...tenant,
    async stock(options) {
      const productId = await createProduct(db, tenant.tenantId, {
        ...(options.name !== undefined ? { name: options.name } : {}),
      });

      await db.asServiceRole(async () => {
        await db.query(
          `update products
              set average_cost = $2,
                  tax_mode = coalesce($3::tax_mode, tax_mode),
                  tax_rate = $4,
                  allow_fractional = coalesce($5, allow_fractional)
            where id = $1`,
          [
            productId,
            options.cost ?? 0,
            options.taxMode ?? null,
            options.taxRate ?? null,
            options.allowFractional ?? null,
          ],
        );
        await db.query(
          `insert into product_prices (tenant_id, product_id, tier, amount) values ($1, $2, 'RETAIL', $3)`,
          [tenant.tenantId, productId, options.price],
        );
      });

      if (options.quantity !== undefined && options.quantity > 0) {
        await db.asUser(tenant.ownerUserId, () =>
          db.query(
            `select * from apply_stock_adjustment($1, $2, $3, 'OPENING_STOCK', 'Opening stock')`,
            [tenant.branchId, productId, options.quantity],
          ),
        );
      }

      return productId;
    },
  };
}

export interface CartLine {
  product_id: string;
  quantity: number;
  discount_type?: 'PERCENTAGE' | 'AMOUNT';
  discount_value?: number;
}

export interface Tender {
  method: 'CASH' | 'MOMO' | 'BANK_TRANSFER' | 'CARD' | 'CREDIT' | 'OTHER';
  amount: number;
  reference?: string;
}

export interface SaleResult {
  sale_id: string;
  sale_number: string;
  total: number;
  amount_paid: number;
  change_given: number;
  was_replayed: boolean;
}

export interface SellOptions {
  items: CartLine[];
  payments: Tender[];
  /** Reuse a key across two calls to exercise the retry path. */
  idempotencyKey?: string;
  tier?: 'RETAIL' | 'WHOLESALE';
  customerId?: string;
  orderDiscount?: { type: 'PERCENTAGE' | 'AMOUNT'; value: number; reason?: string };
  soldAt?: string;
  deviceId?: string;
  deviceSecret?: string;
  pepper?: string;
}

/** Completes a sale as the given user. */
export async function sell(
  db: TestDatabase,
  userId: string,
  branchId: string,
  options: SellOptions,
): Promise<SaleResult> {
  const { rows } = await db.asUser(userId, () =>
    db.query<SaleResult>(
      `select * from complete_sale(
         $1, $2::jsonb, $3::jsonb, $4, $5, $6::price_tier, $7, $8, $9,
         $10::discount_type, $11, $12, null, $13::timestamptz, 'POS'
       )`,
      [
        branchId,
        JSON.stringify(options.items),
        JSON.stringify(options.payments),
        options.idempotencyKey ?? randomUUID().replace(/-/g, ''),
        options.customerId ?? null,
        options.tier ?? 'RETAIL',
        options.deviceId ?? null,
        options.deviceSecret ?? null,
        options.pepper ?? null,
        options.orderDiscount?.type ?? 'NONE',
        options.orderDiscount?.value ?? null,
        options.orderDiscount?.reason ?? null,
        options.soldAt ?? null,
      ],
    ),
  );
  const row = rows[0]!;
  return {
    ...row,
    total: Number(row.total),
    amount_paid: Number(row.amount_paid),
    change_given: Number(row.change_given),
  };
}

/** Grants a permission to a tenant's role, for tests that need a specific capability. */
export async function grantPermission(
  db: TestDatabase,
  tenantId: string,
  roleKey: string,
  permission: string,
): Promise<void> {
  await db.asServiceRole(() =>
    db.query(
      `insert into role_permissions (role_id, permission_key)
       select r.id, $3 from roles r where r.tenant_id = $1 and r.key = $2
       on conflict do nothing`,
      [tenantId, roleKey, permission],
    ),
  );
}

/** Removes a permission, for tests that need to prove an operation is actually gated. */
export async function revokePermission(
  db: TestDatabase,
  tenantId: string,
  roleKey: string,
  permission: string,
): Promise<void> {
  await db.asServiceRole(() =>
    db.query(
      `delete from role_permissions rp
        using roles r
       where rp.role_id = r.id and r.tenant_id = $1 and r.key = $2 and rp.permission_key = $3`,
      [tenantId, roleKey, permission],
    ),
  );
}
