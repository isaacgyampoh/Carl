/**
 * The terminal's local copy of what it sells.
 *
 * ## Why this is worth testing carefully
 *
 * When the connection is up, prices come from PostgreSQL and this file is a cache. When it
 * is down, this file *is* the price list — it decides what a customer is charged. A bug
 * here is not a stale screen; it is money.
 *
 * So the price resolution below deliberately mirrors the server's: same tier, same
 * quantity-break semantics, same "most specific wins". The branch override is already
 * resolved by `device_catalogue` before it arrives, which is why there is no branch column
 * here — one implementation of that rule, on the server, where the sale is charged.
 *
 * ## Applying a pull
 *
 * A catalogue pull is applied in one transaction. A half-applied catalogue — products
 * updated, prices not — would sell today's items at yesterday's prices, and would do it
 * silently.
 */

import type { SqliteConnection } from '@carl/sync';

/** The response from `POST /api/device/catalogue`. */
export interface CataloguePayload {
  readonly server_time: string;
  readonly tenant_id: string;
  readonly branch_id: string;
  readonly products: readonly ProductRow[];
  readonly removed_products: readonly string[];
  readonly barcodes: readonly BarcodeRow[];
  readonly prices: readonly PriceRow[];
  readonly stock: readonly StockRow[];
  readonly customers: readonly CustomerRow[];
}

export interface ProductRow {
  readonly id: string;
  readonly name: string;
  readonly sku: string;
  readonly unit: string;
  readonly allow_fractional: boolean;
  readonly is_stock_tracked: boolean;
  readonly tax_mode: string;
  readonly tax_rate: number;
  readonly updated_at: string;
}

export interface BarcodeRow {
  readonly barcode: string;
  readonly product_id: string;
  readonly pack_size: number;
}

export interface PriceRow {
  readonly product_id: string;
  readonly tier: string;
  readonly min_quantity: number;
  readonly amount: number;
}

export interface StockRow {
  readonly product_id: string;
  readonly quantity: number;
  readonly as_of: string;
}

export interface CustomerRow {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly default_tier: string;
}

/** A product as the till needs it: what it is, what it costs, how much is left. */
export interface CatalogueItem {
  readonly id: string;
  readonly name: string;
  readonly sku: string;
  readonly unit: string;
  readonly allowFractional: boolean;
  readonly isStockTracked: boolean;
  readonly taxMode: string;
  readonly taxRate: number;
  /** Minor units. Null when the product has no price for the requested tier. */
  readonly price: number | null;
  readonly stock: number;
  /** When the server last confirmed that stock figure. */
  readonly stockAsOf: string | null;
}

interface RawItem {
  id: string;
  name: string;
  sku: string;
  unit: string;
  allow_fractional: number;
  is_stock_tracked: number;
  tax_mode: string;
  tax_rate: number;
  price: number | null;
  stock: number | null;
  as_of: string | null;
}

const toItem = (row: RawItem): CatalogueItem => ({
  id: row.id,
  name: row.name,
  sku: row.sku,
  unit: row.unit,
  allowFractional: row.allow_fractional === 1,
  isStockTracked: row.is_stock_tracked === 1,
  taxMode: row.tax_mode,
  taxRate: row.tax_rate,
  price: row.price,
  stock: row.stock ?? 0,
  stockAsOf: row.as_of,
});

export class CatalogueStore {
  constructor(private readonly db: SqliteConnection) {}

  /**
   * Writes a pull into the local database.
   *
   * Everything or nothing. A crash midway leaves the previous catalogue intact, which is
   * strictly better than a mixture of two.
   */
  async apply(payload: CataloguePayload): Promise<void> {
    await this.db.execute('begin');
    try {
      for (const product of payload.products) {
        await this.db.execute(
          `insert into products (id, name, sku, unit, allow_fractional, is_stock_tracked, tax_mode, tax_rate, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict (id) do update set
             name = excluded.name, sku = excluded.sku, unit = excluded.unit,
             allow_fractional = excluded.allow_fractional,
             is_stock_tracked = excluded.is_stock_tracked,
             tax_mode = excluded.tax_mode, tax_rate = excluded.tax_rate,
             updated_at = excluded.updated_at`,
          [
            product.id,
            product.name,
            product.sku,
            product.unit,
            product.allow_fractional ? 1 : 0,
            product.is_stock_tracked ? 1 : 0,
            product.tax_mode,
            product.tax_rate,
            product.updated_at,
          ],
        );
      }

      // Withdrawn products are deleted rather than flagged. A till that keeps a hidden row
      // eventually shows it again through some path nobody remembered to filter.
      for (const id of payload.removed_products) {
        await this.db.execute('delete from products where id = ?', [id]);
      }

      // Barcodes and prices arrive as a complete set for the products in the pull, so the
      // old rows for those products go first. Merging would leave a withdrawn quantity
      // break in place, and the till would honour a price the business had cancelled.
      const touched = payload.products.map((p) => p.id);
      if (payload.barcodes.length > 0 || touched.length > 0) {
        for (const id of touched) {
          await this.db.execute('delete from product_barcodes where product_id = ?', [id]);
          await this.db.execute('delete from product_prices where product_id = ?', [id]);
        }
      }

      for (const barcode of payload.barcodes) {
        await this.db.execute(
          `insert into product_barcodes (barcode, product_id, pack_size) values (?, ?, ?)
           on conflict (barcode) do update set product_id = excluded.product_id, pack_size = excluded.pack_size`,
          [barcode.barcode, barcode.product_id, barcode.pack_size],
        );
      }

      for (const price of payload.prices) {
        await this.db.execute(
          `insert into product_prices (product_id, tier, min_quantity, amount) values (?, ?, ?, ?)
           on conflict (product_id, tier, min_quantity) do update set amount = excluded.amount`,
          [price.product_id, price.tier, price.min_quantity, price.amount],
        );
      }

      for (const level of payload.stock) {
        await this.db.execute(
          `insert into stock_levels (product_id, quantity, as_of) values (?, ?, ?)
           on conflict (product_id) do update set quantity = excluded.quantity, as_of = excluded.as_of`,
          [level.product_id, level.quantity, level.as_of],
        );
      }

      for (const customer of payload.customers) {
        await this.db.execute(
          `insert into customers (id, name, phone, default_tier) values (?, ?, ?, ?)
           on conflict (id) do update set name = excluded.name, phone = excluded.phone,
             default_tier = excluded.default_tier`,
          [customer.id, customer.name, customer.phone, customer.default_tier],
        );
      }

      await this.db.execute(
        `update device_config set catalogue_version = ?, last_sync_at = ? where id = 1`,
        [payload.server_time, payload.server_time],
      );

      await this.db.execute('commit');
    } catch (error) {
      await this.db.execute('rollback').catch(() => undefined);
      throw error;
    }
  }

  /**
   * The price for a product at a tier and quantity.
   *
   * Picks the highest quantity break at or below the quantity being sold — a wholesale
   * price starting at 12 applies to 20, not to 6. Falls back to RETAIL when the requested
   * tier has no row, which is what stops a wholesale customer buying at no price at all.
   */
  private priceExpression(): string {
    return `(
      select pp.amount
        from product_prices pp
       where pp.product_id = p.id
         and pp.tier = ?
         and pp.min_quantity <= ?
       order by pp.min_quantity desc
       limit 1
    )`;
  }

  /**
   * The common projection. `extra` adds columns, `from` adds joins.
   *
   * Parameter order is fixed by this string and every caller must match it:
   * tier, quantity, quantity, then whatever the WHERE clause needs.
   */
  private selectItems(where: string, extra = '', from = ''): string {
    return `select p.id, p.name, p.sku, p.unit, p.allow_fractional, p.is_stock_tracked,
                   p.tax_mode, p.tax_rate${extra},
                   coalesce(${this.priceExpression()},
                            (select pp2.amount from product_prices pp2
                              where pp2.product_id = p.id and pp2.tier = 'RETAIL'
                                and pp2.min_quantity <= ?
                              order by pp2.min_quantity desc limit 1)) as price,
                   sl.quantity as stock, sl.as_of
              from products p
              left join stock_levels sl on sl.product_id = p.id
              ${from}
             ${where}`;
  }

  /** Free-text search across name and SKU, for the cashier's search box. */
  async search(term: string, tier = 'RETAIL', limit = 50): Promise<CatalogueItem[]> {
    const like = `%${term.trim()}%`;
    const rows = await this.db.select<RawItem>(
      `${this.selectItems('where p.name like ? or p.sku like ?')} order by p.name limit ?`,
      [tier, 1, 1, like, like, limit],
    );
    return rows.map(toItem);
  }

  /**
   * Resolves a scanned barcode.
   *
   * Returns the pack size alongside the product: scanning a case of 24 must add 24, not 1.
   */
  async scan(
    barcode: string,
    tier = 'RETAIL',
  ): Promise<{ item: CatalogueItem; packSize: number } | null> {
    const rows = await this.db.select<RawItem & { pack_size: number }>(
      this.selectItems(
        'where b.barcode = ?',
        ', b.pack_size',
        'join product_barcodes b on b.product_id = p.id',
      ),
      [tier, 1, 1, barcode.trim()],
    );
    const row = rows[0];
    return row ? { item: toItem(row), packSize: row.pack_size } : null;
  }

  /** The price for a specific quantity, used when a line's quantity changes. */
  async priceFor(productId: string, quantity: number, tier = 'RETAIL'): Promise<number | null> {
    const rows = await this.db.select<RawItem>(`${this.selectItems('where p.id = ?')}`, [
      tier,
      quantity,
      quantity,
      productId,
    ]);
    return rows[0]?.price ?? null;
  }

  async findCustomers(term: string, limit = 20): Promise<CustomerRow[]> {
    const like = `%${term.trim()}%`;
    return this.db.select<CustomerRow>(
      `select id, name, phone, default_tier from customers
        where name like ? or phone like ? order by name limit ?`,
      [like, like, limit],
    );
  }
}
