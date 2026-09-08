/**
 * Carl's permission catalogue.
 *
 * This file is the single source of truth. The database seeds its `permissions` table from
 * this list, and a database test asserts the two never drift — so adding a permission here
 * and forgetting the migration is a failing test rather than a silent authorization hole.
 *
 * Permissions are named `resource.action`. They are checked in PostgreSQL (which is what
 * actually enforces them) and mirrored in the UI purely to avoid showing a cashier a button
 * that will refuse them. Hiding a button is not access control.
 */

export const Permission = {
  // --- Sales & POS ---
  SALES_VIEW: 'sales.view',
  SALES_VIEW_ALL: 'sales.view_all',
  SALES_CREATE: 'sales.create',
  SALES_VOID: 'sales.void',
  SALES_REFUND: 'sales.refund',
  SALES_DISCOUNT: 'sales.discount',
  SALES_DISCOUNT_UNRESTRICTED: 'sales.discount_unrestricted',
  SALES_PRICE_OVERRIDE: 'sales.price_override',
  SALES_SELL_WHOLESALE: 'sales.sell_wholesale',

  // --- Catalogue ---
  PRODUCTS_VIEW: 'products.view',
  PRODUCTS_CREATE: 'products.create',
  PRODUCTS_UPDATE: 'products.update',
  PRODUCTS_DELETE: 'products.delete',
  PRODUCTS_VIEW_COST: 'products.view_cost',
  PRODUCTS_MANAGE_PRICING: 'products.manage_pricing',
  CATEGORIES_MANAGE: 'categories.manage',

  // --- Inventory ---
  INVENTORY_VIEW: 'inventory.view',
  INVENTORY_ADJUST: 'inventory.adjust',
  INVENTORY_TRANSFER_CREATE: 'inventory.transfer_create',
  INVENTORY_TRANSFER_APPROVE: 'inventory.transfer_approve',
  INVENTORY_TRANSFER_RECEIVE: 'inventory.transfer_receive',
  INVENTORY_COUNT_CREATE: 'inventory.count_create',
  INVENTORY_COUNT_APPROVE: 'inventory.count_approve',

  // --- Purchasing & suppliers ---
  PURCHASES_VIEW: 'purchases.view',
  PURCHASES_CREATE: 'purchases.create',
  PURCHASES_RECEIVE: 'purchases.receive',
  PURCHASES_DELETE: 'purchases.delete',
  SUPPLIERS_VIEW: 'suppliers.view',
  SUPPLIERS_MANAGE: 'suppliers.manage',

  // --- Customers ---
  CUSTOMERS_VIEW: 'customers.view',
  CUSTOMERS_CREATE: 'customers.create',
  CUSTOMERS_UPDATE: 'customers.update',
  CUSTOMERS_DELETE: 'customers.delete',

  // --- Money ---
  EXPENSES_VIEW: 'expenses.view',
  EXPENSES_CREATE: 'expenses.create',
  EXPENSES_APPROVE: 'expenses.approve',
  REGISTER_OPEN: 'register.open',
  REGISTER_CLOSE: 'register.close',
  REGISTER_CASH_MOVEMENT: 'register.cash_movement',
  REGISTER_VIEW_VARIANCE: 'register.view_variance',

  // --- Reporting ---
  REPORTS_VIEW: 'reports.view',
  REPORTS_VIEW_FINANCIAL: 'reports.view_financial',
  REPORTS_VIEW_ALL_BRANCHES: 'reports.view_all_branches',
  REPORTS_EXPORT: 'reports.export',

  // --- Organisation ---
  BRANCHES_VIEW: 'branches.view',
  BRANCHES_MANAGE: 'branches.manage',
  STAFF_VIEW: 'staff.view',
  STAFF_MANAGE: 'staff.manage',
  ROLES_MANAGE: 'roles.manage',
  SETTINGS_VIEW: 'settings.view',
  SETTINGS_MANAGE: 'settings.manage',

  // --- Devices ---
  DEVICES_VIEW: 'devices.view',
  DEVICES_MANAGE: 'devices.manage',

  // --- Audit ---
  AUDIT_VIEW: 'audit.view',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);

/** Grouping used to render the role editor. Purely presentational. */
export const PERMISSION_GROUPS: Readonly<Record<string, readonly Permission[]>> = {
  Sales: [
    Permission.SALES_VIEW,
    Permission.SALES_VIEW_ALL,
    Permission.SALES_CREATE,
    Permission.SALES_VOID,
    Permission.SALES_REFUND,
    Permission.SALES_DISCOUNT,
    Permission.SALES_DISCOUNT_UNRESTRICTED,
    Permission.SALES_PRICE_OVERRIDE,
    Permission.SALES_SELL_WHOLESALE,
  ],
  Catalogue: [
    Permission.PRODUCTS_VIEW,
    Permission.PRODUCTS_CREATE,
    Permission.PRODUCTS_UPDATE,
    Permission.PRODUCTS_DELETE,
    Permission.PRODUCTS_VIEW_COST,
    Permission.PRODUCTS_MANAGE_PRICING,
    Permission.CATEGORIES_MANAGE,
  ],
  Inventory: [
    Permission.INVENTORY_VIEW,
    Permission.INVENTORY_ADJUST,
    Permission.INVENTORY_TRANSFER_CREATE,
    Permission.INVENTORY_TRANSFER_APPROVE,
    Permission.INVENTORY_TRANSFER_RECEIVE,
    Permission.INVENTORY_COUNT_CREATE,
    Permission.INVENTORY_COUNT_APPROVE,
  ],
  Purchasing: [
    Permission.PURCHASES_VIEW,
    Permission.PURCHASES_CREATE,
    Permission.PURCHASES_RECEIVE,
    Permission.PURCHASES_DELETE,
    Permission.SUPPLIERS_VIEW,
    Permission.SUPPLIERS_MANAGE,
  ],
  Customers: [
    Permission.CUSTOMERS_VIEW,
    Permission.CUSTOMERS_CREATE,
    Permission.CUSTOMERS_UPDATE,
    Permission.CUSTOMERS_DELETE,
  ],
  Money: [
    Permission.EXPENSES_VIEW,
    Permission.EXPENSES_CREATE,
    Permission.EXPENSES_APPROVE,
    Permission.REGISTER_OPEN,
    Permission.REGISTER_CLOSE,
    Permission.REGISTER_CASH_MOVEMENT,
    Permission.REGISTER_VIEW_VARIANCE,
  ],
  Reports: [
    Permission.REPORTS_VIEW,
    Permission.REPORTS_VIEW_FINANCIAL,
    Permission.REPORTS_VIEW_ALL_BRANCHES,
    Permission.REPORTS_EXPORT,
  ],
  Organisation: [
    Permission.BRANCHES_VIEW,
    Permission.BRANCHES_MANAGE,
    Permission.STAFF_VIEW,
    Permission.STAFF_MANAGE,
    Permission.ROLES_MANAGE,
    Permission.SETTINGS_VIEW,
    Permission.SETTINGS_MANAGE,
  ],
  Devices: [Permission.DEVICES_VIEW, Permission.DEVICES_MANAGE],
  Audit: [Permission.AUDIT_VIEW],
};

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (ALL_PERMISSIONS as readonly string[]).includes(value);
}
