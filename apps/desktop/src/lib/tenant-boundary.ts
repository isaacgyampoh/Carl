/**
 * What a till holds for the business it belongs to, and what happens when that changes.
 *
 * One installation of Carl POS serves one business. Its SQLite file holds that business's
 * catalogue, prices, stock, customers, receipts and queued sales. Activation used to
 * overwrite only the device configuration, so a till re-activated with another business's
 * code kept the first business's catalogue on screen and, worse, sent the first business's
 * unsent sales under the new business's credential. Each was then declined and stored in
 * the new business's conflict records, payload and all: one merchant's takings filed in
 * another merchant's account.
 *
 * So the rule, decided here and applied by the activation screen:
 *
 *   * The same terminal re-authorising (a lost keychain, a re-issued code) keeps everything,
 *     including sales still waiting to send, which will now go with the new secret.
 *   * Any other change (a different business, branch or terminal) wipes the previous
 *     business's local data before the new one is written.
 *   * And that change is refused while a sale has not reached Carl. Those sales are the
 *     previous business's money; they must never be deleted, and must never be sent as
 *     somebody else.
 */

import type { SqliteConnection } from '@carl/sync';

import type { DeviceConfig } from './device-store';

export type Rebinding =
  | { readonly kind: 'first' }
  | { readonly kind: 'same' }
  | { readonly kind: 'switch' }
  | { readonly kind: 'refuse'; readonly unsynced: number; readonly previousTenantName: string };

export function decideRebinding(
  previous: DeviceConfig | null,
  next: { readonly tenantId: string; readonly branchId: string; readonly deviceId: string },
  unsynced: number,
): Rebinding {
  if (!previous) return { kind: 'first' };
  if (
    previous.tenantId === next.tenantId &&
    previous.branchId === next.branchId &&
    previous.deviceId === next.deviceId
  ) {
    return { kind: 'same' };
  }
  if (unsynced > 0) {
    return { kind: 'refuse', unsynced, previousTenantName: previous.tenantName };
  }
  return { kind: 'switch' };
}

/** Local tables that belong to a business, children before parents. */
const BUSINESS_TABLES = [
  'local_receipts',
  'sync_queue',
  'stock_levels',
  'product_prices',
  'product_barcodes',
  'products',
  'customers',
  'device_config',
] as const;

export class TenantBoundary {
  constructor(private readonly db: SqliteConnection) {}

  /** Operations that have not been accepted by the server: every state except SYNCED. */
  async unsyncedCount(): Promise<number> {
    const rows = await this.db.select<{ n: number }>(
      `select count(*) as n from sync_queue where state <> 'SYNCED'`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Removes everything the previous business left on this till.
   *
   * Local settings (the install id, the chosen printer) describe the machine, not a
   * business, and are kept.
   */
  async wipeBusinessData(): Promise<void> {
    for (const table of BUSINESS_TABLES) {
      await this.db.execute(`delete from ${table}`);
    }
  }
}
