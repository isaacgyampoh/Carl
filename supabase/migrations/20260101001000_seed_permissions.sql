-- =============================================================================
-- 0010 · Permission catalogue seed
--
-- GENERATED FILE — do not edit by hand.
--
-- Regenerate with:  node scripts/generate-permissions-migration.mjs
-- Source of truth:  packages/domain/src/access/permissions.ts
--
-- tests/db/permissions.test.ts asserts this table and the TypeScript catalogue contain
-- exactly the same keys, so adding a permission and forgetting to regenerate is a
-- failing test rather than a silent authorization hole.
--
-- 54 permissions.
-- =============================================================================

insert into permissions (key, resource, action, description) values
  ('sales.view', 'sales', 'view', 'View — sales'),
  ('sales.view_all', 'sales', 'view_all', 'View all — sales'),
  ('sales.create', 'sales', 'create', 'Create — sales'),
  ('sales.void', 'sales', 'void', 'Void — sales'),
  ('sales.refund', 'sales', 'refund', 'Refund — sales'),
  ('sales.discount', 'sales', 'discount', 'Discount — sales'),
  ('sales.discount_unrestricted', 'sales', 'discount_unrestricted', 'Discount unrestricted — sales'),
  ('sales.price_override', 'sales', 'price_override', 'Price override — sales'),
  ('sales.sell_wholesale', 'sales', 'sell_wholesale', 'Sell wholesale — sales'),
  ('products.view', 'products', 'view', 'View — products'),
  ('products.create', 'products', 'create', 'Create — products'),
  ('products.update', 'products', 'update', 'Update — products'),
  ('products.delete', 'products', 'delete', 'Delete — products'),
  ('products.view_cost', 'products', 'view_cost', 'View cost — products'),
  ('products.manage_pricing', 'products', 'manage_pricing', 'Manage pricing — products'),
  ('categories.manage', 'categories', 'manage', 'Manage — categories'),
  ('inventory.view', 'inventory', 'view', 'View — inventory'),
  ('inventory.adjust', 'inventory', 'adjust', 'Adjust — inventory'),
  ('inventory.transfer_create', 'inventory', 'transfer_create', 'Transfer create — inventory'),
  ('inventory.transfer_approve', 'inventory', 'transfer_approve', 'Transfer approve — inventory'),
  ('inventory.transfer_receive', 'inventory', 'transfer_receive', 'Transfer receive — inventory'),
  ('inventory.count_create', 'inventory', 'count_create', 'Count create — inventory'),
  ('inventory.count_approve', 'inventory', 'count_approve', 'Count approve — inventory'),
  ('purchases.view', 'purchases', 'view', 'View — purchases'),
  ('purchases.create', 'purchases', 'create', 'Create — purchases'),
  ('purchases.receive', 'purchases', 'receive', 'Receive — purchases'),
  ('purchases.delete', 'purchases', 'delete', 'Delete — purchases'),
  ('suppliers.view', 'suppliers', 'view', 'View — suppliers'),
  ('suppliers.manage', 'suppliers', 'manage', 'Manage — suppliers'),
  ('customers.view', 'customers', 'view', 'View — customers'),
  ('customers.create', 'customers', 'create', 'Create — customers'),
  ('customers.update', 'customers', 'update', 'Update — customers'),
  ('customers.delete', 'customers', 'delete', 'Delete — customers'),
  ('expenses.view', 'expenses', 'view', 'View — expenses'),
  ('expenses.create', 'expenses', 'create', 'Create — expenses'),
  ('expenses.approve', 'expenses', 'approve', 'Approve — expenses'),
  ('register.open', 'register', 'open', 'Open — register'),
  ('register.close', 'register', 'close', 'Close — register'),
  ('register.cash_movement', 'register', 'cash_movement', 'Cash movement — register'),
  ('register.view_variance', 'register', 'view_variance', 'View variance — register'),
  ('reports.view', 'reports', 'view', 'View — reports'),
  ('reports.view_financial', 'reports', 'view_financial', 'View financial — reports'),
  ('reports.view_all_branches', 'reports', 'view_all_branches', 'View all branches — reports'),
  ('reports.export', 'reports', 'export', 'Export — reports'),
  ('branches.view', 'branches', 'view', 'View — branches'),
  ('branches.manage', 'branches', 'manage', 'Manage — branches'),
  ('staff.view', 'staff', 'view', 'View — staff'),
  ('staff.manage', 'staff', 'manage', 'Manage — staff'),
  ('roles.manage', 'roles', 'manage', 'Manage — roles'),
  ('settings.view', 'settings', 'view', 'View — settings'),
  ('settings.manage', 'settings', 'manage', 'Manage — settings'),
  ('devices.view', 'devices', 'view', 'View — devices'),
  ('devices.manage', 'devices', 'manage', 'Manage — devices'),
  ('audit.view', 'audit', 'view', 'View — audit')
on conflict (key) do update
  set resource    = excluded.resource,
      action      = excluded.action,
      description = excluded.description;
