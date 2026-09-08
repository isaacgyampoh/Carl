/**
 * Names of PostgreSQL functions Carl calls as RPCs.
 *
 * Carl's critical writes are transactions spanning several tables — a sale touches
 * `sales`, `sale_items`, `payments`, `inventory` and `inventory_movements`, and must either
 * do all of it or none of it. That is not expressible as a sequence of PostgREST calls from a
 * client, so those operations live in the database as functions and are invoked by name.
 *
 * Centralising the names here means a renamed function is a compile error rather than a
 * runtime 404 discovered by a cashier.
 */
export const Rpc = {
  COMPLETE_SALE: 'complete_sale',
  VOID_SALE: 'void_sale',
  PROCESS_RETURN: 'process_return',
  RECEIVE_PURCHASE: 'receive_purchase',
  APPLY_STOCK_ADJUSTMENT: 'apply_stock_adjustment',
  CREATE_STOCK_TRANSFER: 'create_stock_transfer',
  RECEIVE_STOCK_TRANSFER: 'receive_stock_transfer',
  APPLY_STOCK_COUNT: 'apply_stock_count',
  OPEN_CASH_SESSION: 'open_cash_session',
  CLOSE_CASH_SESSION: 'close_cash_session',
  SYNC_OFFLINE_SALE: 'sync_offline_sale',
  ACTIVATE_DEVICE: 'activate_device',
  PROVISION_TENANT: 'provision_tenant',
} as const;

export type Rpc = (typeof Rpc)[keyof typeof Rpc];
