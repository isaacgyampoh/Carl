/**
 * System role templates.
 *
 * Every tenant is provisioned with these roles. They are *templates*, not fixed definitions:
 * a tenant admin may create additional roles and adjust permissions on non-system roles,
 * which is why permissions live in a join table rather than being hard-coded against a role
 * enum.
 *
 * The grants below encode real operational judgement rather than a tidy hierarchy:
 *
 *   - A cashier can sell and can look up a customer, but cannot see cost prices (which would
 *     expose the business's margins to every temporary employee) and cannot refund without a
 *     supervisor.
 *   - A supervisor can refund and discount, but cannot change what a product costs.
 *   - An accountant sees money but cannot sell or alter stock.
 *   - An inventory manager moves stock but cannot see sales revenue.
 *
 * Separating "can operate the till" from "can change prices" is the control that makes a POS
 * auditable at all.
 */

import { Permission } from './permissions.js';

export const SystemRole = {
  TENANT_OWNER: 'tenant_owner',
  TENANT_ADMIN: 'tenant_admin',
  BRANCH_MANAGER: 'branch_manager',
  SUPERVISOR: 'supervisor',
  CASHIER: 'cashier',
  INVENTORY_MANAGER: 'inventory_manager',
  ACCOUNTANT: 'accountant',
  STAFF: 'staff',
} as const;

export type SystemRole = (typeof SystemRole)[keyof typeof SystemRole];

export interface RoleTemplate {
  readonly key: SystemRole;
  readonly name: string;
  readonly description: string;
  /** Lower binds more authority. Used to stop a user granting a role above their own. */
  readonly rank: number;
  readonly permissions: readonly Permission[];
}

const CASHIER_PERMISSIONS: readonly Permission[] = [
  Permission.SALES_VIEW,
  Permission.SALES_CREATE,
  Permission.PRODUCTS_VIEW,
  Permission.INVENTORY_VIEW,
  Permission.CUSTOMERS_VIEW,
  Permission.CUSTOMERS_CREATE,
  Permission.REGISTER_OPEN,
  Permission.REGISTER_CLOSE,
];

const SUPERVISOR_PERMISSIONS: readonly Permission[] = [
  ...CASHIER_PERMISSIONS,
  Permission.SALES_VIEW_ALL,
  Permission.SALES_VOID,
  Permission.SALES_REFUND,
  Permission.SALES_DISCOUNT,
  Permission.SALES_SELL_WHOLESALE,
  Permission.CUSTOMERS_UPDATE,
  Permission.REGISTER_CASH_MOVEMENT,
  Permission.REGISTER_VIEW_VARIANCE,
  Permission.EXPENSES_VIEW,
  Permission.EXPENSES_CREATE,
  Permission.REPORTS_VIEW,
  Permission.STAFF_VIEW,
];

const INVENTORY_MANAGER_PERMISSIONS: readonly Permission[] = [
  Permission.PRODUCTS_VIEW,
  Permission.PRODUCTS_CREATE,
  Permission.PRODUCTS_UPDATE,
  Permission.PRODUCTS_VIEW_COST,
  Permission.CATEGORIES_MANAGE,
  Permission.INVENTORY_VIEW,
  Permission.INVENTORY_ADJUST,
  Permission.INVENTORY_TRANSFER_CREATE,
  Permission.INVENTORY_TRANSFER_APPROVE,
  Permission.INVENTORY_TRANSFER_RECEIVE,
  Permission.INVENTORY_COUNT_CREATE,
  Permission.INVENTORY_COUNT_APPROVE,
  Permission.PURCHASES_VIEW,
  Permission.PURCHASES_CREATE,
  Permission.PURCHASES_RECEIVE,
  Permission.SUPPLIERS_VIEW,
  Permission.SUPPLIERS_MANAGE,
  Permission.REPORTS_VIEW,
];

const ACCOUNTANT_PERMISSIONS: readonly Permission[] = [
  Permission.SALES_VIEW,
  Permission.SALES_VIEW_ALL,
  Permission.PRODUCTS_VIEW,
  Permission.PRODUCTS_VIEW_COST,
  Permission.INVENTORY_VIEW,
  Permission.PURCHASES_VIEW,
  Permission.SUPPLIERS_VIEW,
  Permission.CUSTOMERS_VIEW,
  Permission.EXPENSES_VIEW,
  Permission.EXPENSES_CREATE,
  Permission.EXPENSES_APPROVE,
  Permission.REGISTER_VIEW_VARIANCE,
  Permission.REPORTS_VIEW,
  Permission.REPORTS_VIEW_FINANCIAL,
  Permission.REPORTS_VIEW_ALL_BRANCHES,
  Permission.REPORTS_EXPORT,
  Permission.AUDIT_VIEW,
];

const BRANCH_MANAGER_PERMISSIONS: readonly Permission[] = [
  ...SUPERVISOR_PERMISSIONS,
  ...INVENTORY_MANAGER_PERMISSIONS,
  Permission.SALES_DISCOUNT_UNRESTRICTED,
  Permission.SALES_PRICE_OVERRIDE,
  Permission.PRODUCTS_MANAGE_PRICING,
  Permission.EXPENSES_APPROVE,
  Permission.REPORTS_VIEW_FINANCIAL,
  Permission.REPORTS_EXPORT,
  Permission.STAFF_MANAGE,
  Permission.DEVICES_VIEW,
  Permission.BRANCHES_VIEW,
  Permission.SETTINGS_VIEW,
];

/**
 * Tenant admins hold every permission *within their own tenant*.
 *
 * Note this is not platform administration — a tenant admin has no visibility of any other
 * tenant, and no route into Carl's platform tables. Those are entirely separate.
 */
const TENANT_ADMIN_PERMISSIONS: readonly Permission[] = Object.values(Permission);

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    key: SystemRole.TENANT_OWNER,
    name: 'Owner',
    description:
      'The business owner. Full control of the tenant, including billing and transferring ownership.',
    rank: 10,
    permissions: TENANT_ADMIN_PERMISSIONS,
  },
  {
    key: SystemRole.TENANT_ADMIN,
    name: 'Administrator',
    description: 'Full control of the business across every branch.',
    rank: 20,
    permissions: TENANT_ADMIN_PERMISSIONS,
  },
  {
    key: SystemRole.BRANCH_MANAGER,
    name: 'Branch Manager',
    description: 'Runs one or more branches: staff, stock, pricing, refunds and reporting.',
    rank: 30,
    permissions: dedupe(BRANCH_MANAGER_PERMISSIONS),
  },
  {
    key: SystemRole.INVENTORY_MANAGER,
    name: 'Inventory Manager',
    description: 'Manages stock, purchasing and suppliers. No access to sales revenue.',
    rank: 40,
    permissions: INVENTORY_MANAGER_PERMISSIONS,
  },
  {
    key: SystemRole.ACCOUNTANT,
    name: 'Accountant',
    description: 'Reads financial data across branches. Cannot sell or change stock.',
    rank: 40,
    permissions: ACCOUNTANT_PERMISSIONS,
  },
  {
    key: SystemRole.SUPERVISOR,
    name: 'Supervisor',
    description: 'Runs a shift: approves refunds and discounts, handles the cash drawer.',
    rank: 50,
    permissions: SUPERVISOR_PERMISSIONS,
  },
  {
    key: SystemRole.CASHIER,
    name: 'Cashier',
    description: 'Operates the till. Cannot refund, discount, or view cost prices.',
    rank: 60,
    permissions: CASHIER_PERMISSIONS,
  },
  {
    key: SystemRole.STAFF,
    name: 'Staff',
    description: 'Read-only access to the catalogue and stock levels.',
    rank: 70,
    permissions: [Permission.PRODUCTS_VIEW, Permission.INVENTORY_VIEW],
  },
];

export function roleTemplate(key: SystemRole): RoleTemplate {
  const template = ROLE_TEMPLATES.find((r) => r.key === key);
  if (!template) throw new Error(`Unknown system role: ${key}`);
  return template;
}

function dedupe(permissions: readonly Permission[]): readonly Permission[] {
  return [...new Set(permissions)];
}
