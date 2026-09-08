-- =============================================================================
-- 0013 · Row Level Security — business tables
--
-- Every table here is tenant-owned, and most are additionally branch-scoped. The pattern
-- throughout:
--
--   SELECT   can_read_tenant + the relevant view permission (+ branch access)
--   INSERT   can_write_tenant + the relevant write permission + branch access
--   UPDATE   as INSERT, with USING and WITH CHECK both applied
--   DELETE   generally absent — financial records are voided, never removed
--
-- ## Why USING and WITH CHECK are both specified on every UPDATE
--
-- `USING` decides which rows may be updated. `WITH CHECK` decides what they may be
-- updated *to*. A policy with only `USING` lets a user take a row they legitimately own
-- and rewrite its `tenant_id` or `branch_id` to another — moving their own record into
-- someone else's business, or a cashier's sale into a branch they cannot see.
--
-- Every UPDATE policy below therefore specifies both, and a test asserts the transfer is
-- refused.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Catalogue
-- -----------------------------------------------------------------------------

alter table categories enable row level security;
alter table categories force row level security;

create policy categories_select on categories
  for select to authenticated
  using ((select app.can_read_tenant(categories.tenant_id)));

create policy categories_write on categories
  for all to authenticated
  using (
    (select app.can_write_tenant(categories.tenant_id))
    and (select app.has_permission(categories.tenant_id, 'categories.manage'))
  )
  with check (
    (select app.can_write_tenant(categories.tenant_id))
    and (select app.has_permission(categories.tenant_id, 'categories.manage'))
  );

alter table products enable row level security;
alter table products force row level security;

create policy products_select on products
  for select to authenticated
  using (
    (select app.can_read(products.tenant_id, 'products.view'))
  );

create policy products_insert on products
  for insert to authenticated
  with check (
    (select app.can_write_tenant(products.tenant_id))
    and (select app.has_permission(products.tenant_id, 'products.create'))
  );

create policy products_update on products
  for update to authenticated
  using (
    (select app.can_write_tenant(products.tenant_id))
    and (select app.has_permission(products.tenant_id, 'products.update'))
  )
  with check (
    (select app.can_write_tenant(products.tenant_id))
    and (select app.has_permission(products.tenant_id, 'products.update'))
  );

create policy products_delete on products
  for delete to authenticated
  using (
    (select app.can_write_tenant(products.tenant_id))
    and (select app.has_permission(products.tenant_id, 'products.delete'))
  );

alter table product_barcodes enable row level security;
alter table product_barcodes force row level security;

create policy product_barcodes_select on product_barcodes
  for select to authenticated
  using (
    (select app.can_read(product_barcodes.tenant_id, 'products.view'))
  );

create policy product_barcodes_write on product_barcodes
  for all to authenticated
  using (
    (select app.can_write_tenant(product_barcodes.tenant_id))
    and (select app.has_permission(product_barcodes.tenant_id, 'products.update'))
  )
  with check (
    (select app.can_write_tenant(product_barcodes.tenant_id))
    and (select app.has_permission(product_barcodes.tenant_id, 'products.update'))
  );

alter table product_prices enable row level security;
alter table product_prices force row level security;

-- Every seller needs to read prices, so products.view is enough to see them.
create policy product_prices_select on product_prices
  for select to authenticated
  using (
    (select app.can_read(product_prices.tenant_id, 'products.view'))
  );

-- Setting a price is a separate, stronger permission than editing a product. A cashier
-- who could write here could sell to themselves at any price they liked.
create policy product_prices_write on product_prices
  for all to authenticated
  using (
    (select app.can_write_tenant(product_prices.tenant_id))
    and (select app.has_permission(product_prices.tenant_id, 'products.manage_pricing'))
  )
  with check (
    (select app.can_write_tenant(product_prices.tenant_id))
    and (select app.has_permission(product_prices.tenant_id, 'products.manage_pricing'))
  );

-- -----------------------------------------------------------------------------
-- Inventory
-- -----------------------------------------------------------------------------

alter table inventory enable row level security;
alter table inventory force row level security;

create policy inventory_select on inventory
  for select to authenticated
  using (
    (select app.can_read(inventory.tenant_id, 'inventory.view', inventory.branch_id))
  );

-- No INSERT/UPDATE/DELETE policy for `authenticated`.
--
-- Stock is never written directly. Every change goes through a transactional function
-- that also posts a ledger movement, so the cached total and the ledger cannot diverge.
-- Allowing a direct UPDATE here would let a client set stock to any value with no record
-- of why — the exact failure the ledger exists to prevent.

alter table inventory_movements enable row level security;
alter table inventory_movements force row level security;

create policy inventory_movements_select on inventory_movements
  for select to authenticated
  using (
    (select app.can_read(inventory_movements.tenant_id, 'inventory.view', inventory_movements.branch_id))
  );

-- Written only by transactional functions. UPDATE and DELETE are additionally blocked by
-- the immutability trigger, so even the service role cannot rewrite the ledger.

alter table stock_transfers enable row level security;
alter table stock_transfers force row level security;

-- A transfer is visible from both ends: the sending branch needs to track it and the
-- receiving branch needs to expect it.
create policy stock_transfers_select on stock_transfers
  for select to authenticated
  using (
    (select app.can_read_tenant(stock_transfers.tenant_id))
    and (
      (select app.can_access_branch(stock_transfers.from_branch_id))
      or (select app.can_access_branch(stock_transfers.to_branch_id))
    )
    and (select app.has_permission(stock_transfers.tenant_id, 'inventory.view'))
  );

create policy stock_transfers_insert on stock_transfers
  for insert to authenticated
  with check (
    (select app.can_write_tenant(stock_transfers.tenant_id))
    and (select app.can_access_branch(stock_transfers.from_branch_id))
    and (select app.has_permission(stock_transfers.tenant_id, 'inventory.transfer_create', stock_transfers.from_branch_id))
  );

create policy stock_transfers_update on stock_transfers
  for update to authenticated
  using (
    (select app.can_write_tenant(stock_transfers.tenant_id))
    and (
      (select app.can_access_branch(stock_transfers.from_branch_id))
      or (select app.can_access_branch(stock_transfers.to_branch_id))
    )
    and (
      (select app.has_permission(stock_transfers.tenant_id, 'inventory.transfer_approve'))
      or (select app.has_permission(stock_transfers.tenant_id, 'inventory.transfer_receive'))
    )
  )
  with check (
    (select app.can_write_tenant(stock_transfers.tenant_id))
    and (
      (select app.can_access_branch(stock_transfers.from_branch_id))
      or (select app.can_access_branch(stock_transfers.to_branch_id))
    )
  );

alter table stock_transfer_items enable row level security;
alter table stock_transfer_items force row level security;

create policy stock_transfer_items_select on stock_transfer_items
  for select to authenticated
  using (
    exists (
      select 1 from stock_transfers t
      where t.id = stock_transfer_items.transfer_id
        and (select app.can_read_tenant(t.tenant_id))
        and (
          (select app.can_access_branch(t.from_branch_id))
          or (select app.can_access_branch(t.to_branch_id))
        )
    )
  );

create policy stock_transfer_items_write on stock_transfer_items
  for all to authenticated
  using (
    exists (
      select 1 from stock_transfers t
      where t.id = stock_transfer_items.transfer_id
        and (select app.can_write_tenant(t.tenant_id))
        and (select app.has_permission(t.tenant_id, 'inventory.transfer_create', t.from_branch_id))
    )
  )
  with check (
    exists (
      select 1 from stock_transfers t
      where t.id = stock_transfer_items.transfer_id
        and (select app.can_write_tenant(t.tenant_id))
        and (select app.has_permission(t.tenant_id, 'inventory.transfer_create', t.from_branch_id))
    )
  );

alter table stock_counts enable row level security;
alter table stock_counts force row level security;

create policy stock_counts_select on stock_counts
  for select to authenticated
  using (
    (select app.can_read(stock_counts.tenant_id, 'inventory.view', stock_counts.branch_id))
  );

create policy stock_counts_write on stock_counts
  for all to authenticated
  using (
    (select app.can_write_tenant(stock_counts.tenant_id))
    and (select app.can_access_branch(stock_counts.branch_id))
    and (select app.has_permission(stock_counts.tenant_id, 'inventory.count_create', stock_counts.branch_id))
  )
  with check (
    (select app.can_write_tenant(stock_counts.tenant_id))
    and (select app.can_access_branch(stock_counts.branch_id))
    and (select app.has_permission(stock_counts.tenant_id, 'inventory.count_create', stock_counts.branch_id))
  );

alter table stock_count_items enable row level security;
alter table stock_count_items force row level security;

create policy stock_count_items_select on stock_count_items
  for select to authenticated
  using (
    exists (
      select 1 from stock_counts c
      where c.id = stock_count_items.stock_count_id
        and (select app.can_read_tenant(c.tenant_id))
        and (select app.can_access_branch(c.branch_id))
    )
  );

create policy stock_count_items_write on stock_count_items
  for all to authenticated
  using (
    exists (
      select 1 from stock_counts c
      where c.id = stock_count_items.stock_count_id
        and (select app.can_write_tenant(c.tenant_id))
        and (select app.can_access_branch(c.branch_id))
        and (select app.has_permission(c.tenant_id, 'inventory.count_create', c.branch_id))
    )
  )
  with check (
    exists (
      select 1 from stock_counts c
      where c.id = stock_count_items.stock_count_id
        and (select app.can_write_tenant(c.tenant_id))
        and (select app.can_access_branch(c.branch_id))
        and (select app.has_permission(c.tenant_id, 'inventory.count_create', c.branch_id))
    )
  );

-- -----------------------------------------------------------------------------
-- Customers and suppliers
-- -----------------------------------------------------------------------------

alter table customers enable row level security;
alter table customers force row level security;

create policy customers_select on customers
  for select to authenticated
  using (
    (select app.can_read(customers.tenant_id, 'customers.view'))
  );

create policy customers_insert on customers
  for insert to authenticated
  with check (
    (select app.can_write_tenant(customers.tenant_id))
    and (select app.has_permission(customers.tenant_id, 'customers.create'))
  );

create policy customers_update on customers
  for update to authenticated
  using (
    (select app.can_write_tenant(customers.tenant_id))
    and (select app.has_permission(customers.tenant_id, 'customers.update'))
  )
  with check (
    (select app.can_write_tenant(customers.tenant_id))
    and (select app.has_permission(customers.tenant_id, 'customers.update'))
  );

create policy customers_delete on customers
  for delete to authenticated
  using (
    (select app.can_write_tenant(customers.tenant_id))
    and (select app.has_permission(customers.tenant_id, 'customers.delete'))
  );

alter table suppliers enable row level security;
alter table suppliers force row level security;

create policy suppliers_select on suppliers
  for select to authenticated
  using (
    (select app.can_read(suppliers.tenant_id, 'suppliers.view'))
  );

create policy suppliers_write on suppliers
  for all to authenticated
  using (
    (select app.can_write_tenant(suppliers.tenant_id))
    and (select app.has_permission(suppliers.tenant_id, 'suppliers.manage'))
  )
  with check (
    (select app.can_write_tenant(suppliers.tenant_id))
    and (select app.has_permission(suppliers.tenant_id, 'suppliers.manage'))
  );

-- -----------------------------------------------------------------------------
-- Sales
--
-- Reads are split: `sales.view` sees your own sales, `sales.view_all` sees the branch's.
-- A cashier looking up their own receipt to reprint it is routine; a cashier browsing
-- every colleague's takings is not.
-- -----------------------------------------------------------------------------

alter table sales enable row level security;
alter table sales force row level security;

create policy sales_select_own on sales
  for select to authenticated
  using (
    (select app.can_read(sales.tenant_id, 'sales.view', sales.branch_id))
    and cashier_id = (select app.current_user_id())
  );

create policy sales_select_all on sales
  for select to authenticated
  using (
    (select app.can_read(sales.tenant_id, 'sales.view_all', sales.branch_id))
  );

-- Sales are created by complete_sale() only, so there is no INSERT policy. A direct
-- insert would bypass price derivation, stock checks and payment validation entirely -
-- which is to say, it would bypass the whole point of the system.

-- Voiding is an UPDATE, and requires sales.void.
create policy sales_update_void on sales
  for update to authenticated
  using (
    (select app.can_write_tenant(sales.tenant_id))
    and (select app.can_access_branch(sales.branch_id))
    and (select app.has_permission(sales.tenant_id, 'sales.void', sales.branch_id))
  )
  with check (
    (select app.can_write_tenant(sales.tenant_id))
    and (select app.can_access_branch(sales.branch_id))
  );

alter table sale_items enable row level security;
alter table sale_items force row level security;

create policy sale_items_select on sale_items
  for select to authenticated
  using (
    exists (
      select 1 from sales s
      where s.id = sale_items.sale_id
        and (select app.can_read_tenant(s.tenant_id))
        and (select app.can_access_branch(s.branch_id))
        and (
          (select app.has_permission(s.tenant_id, 'sales.view_all', s.branch_id))
          or (
            (select app.has_permission(s.tenant_id, 'sales.view', s.branch_id))
            and s.cashier_id = (select app.current_user_id())
          )
        )
    )
  );

alter table sale_payments enable row level security;
alter table sale_payments force row level security;

create policy sale_payments_select on sale_payments
  for select to authenticated
  using (
    exists (
      select 1 from sales s
      where s.id = sale_payments.sale_id
        and (select app.can_read_tenant(s.tenant_id))
        and (select app.can_access_branch(s.branch_id))
        and (
          (select app.has_permission(s.tenant_id, 'sales.view_all', s.branch_id))
          or (
            (select app.has_permission(s.tenant_id, 'sales.view', s.branch_id))
            and s.cashier_id = (select app.current_user_id())
          )
        )
    )
  );

-- -----------------------------------------------------------------------------
-- Returns
-- -----------------------------------------------------------------------------

alter table sale_returns enable row level security;
alter table sale_returns force row level security;

create policy sale_returns_select on sale_returns
  for select to authenticated
  using (
    (select app.can_read(sale_returns.tenant_id, 'sales.view', sale_returns.branch_id))
  );

-- Created by process_return() only.

alter table sale_return_items enable row level security;
alter table sale_return_items force row level security;

create policy sale_return_items_select on sale_return_items
  for select to authenticated
  using (
    exists (
      select 1 from sale_returns r
      where r.id = sale_return_items.return_id
        and (select app.can_read_tenant(r.tenant_id))
        and (select app.can_access_branch(r.branch_id))
    )
  );

-- -----------------------------------------------------------------------------
-- Purchasing
-- -----------------------------------------------------------------------------

alter table purchases enable row level security;
alter table purchases force row level security;

create policy purchases_select on purchases
  for select to authenticated
  using (
    (select app.can_read(purchases.tenant_id, 'purchases.view', purchases.branch_id))
  );

create policy purchases_insert on purchases
  for insert to authenticated
  with check (
    (select app.can_write_tenant(purchases.tenant_id))
    and (select app.can_access_branch(purchases.branch_id))
    and (select app.has_permission(purchases.tenant_id, 'purchases.create', purchases.branch_id))
  );

create policy purchases_update on purchases
  for update to authenticated
  using (
    (select app.can_write_tenant(purchases.tenant_id))
    and (select app.can_access_branch(purchases.branch_id))
    and (select app.has_permission(purchases.tenant_id, 'purchases.create', purchases.branch_id))
  )
  with check (
    (select app.can_write_tenant(purchases.tenant_id))
    and (select app.can_access_branch(purchases.branch_id))
  );

alter table purchase_items enable row level security;
alter table purchase_items force row level security;

create policy purchase_items_select on purchase_items
  for select to authenticated
  using (
    exists (
      select 1 from purchases p
      where p.id = purchase_items.purchase_id
        and (select app.can_read(p.tenant_id, 'purchases.view', p.branch_id))
    )
  );

create policy purchase_items_write on purchase_items
  for all to authenticated
  using (
    exists (
      select 1 from purchases p
      where p.id = purchase_items.purchase_id
        and (select app.can_write_tenant(p.tenant_id))
        and (select app.has_permission(p.tenant_id, 'purchases.create', p.branch_id))
    )
  )
  with check (
    exists (
      select 1 from purchases p
      where p.id = purchase_items.purchase_id
        and (select app.can_write_tenant(p.tenant_id))
        and (select app.has_permission(p.tenant_id, 'purchases.create', p.branch_id))
    )
  );

alter table purchase_payments enable row level security;
alter table purchase_payments force row level security;

create policy purchase_payments_select on purchase_payments
  for select to authenticated
  using (
    (select app.can_read(purchase_payments.tenant_id, 'purchases.view', purchase_payments.branch_id))
  );

create policy purchase_payments_insert on purchase_payments
  for insert to authenticated
  with check (
    (select app.can_write_tenant(purchase_payments.tenant_id))
    and (select app.has_permission(purchase_payments.tenant_id, 'purchases.create', purchase_payments.branch_id))
  );

-- -----------------------------------------------------------------------------
-- Expenses
-- -----------------------------------------------------------------------------

alter table expense_categories enable row level security;
alter table expense_categories force row level security;

create policy expense_categories_select on expense_categories
  for select to authenticated
  using (
    (select app.can_read(expense_categories.tenant_id, 'expenses.view'))
  );

create policy expense_categories_write on expense_categories
  for all to authenticated
  using (
    (select app.can_write_tenant(expense_categories.tenant_id))
    and (select app.has_permission(expense_categories.tenant_id, 'expenses.approve'))
  )
  with check (
    (select app.can_write_tenant(expense_categories.tenant_id))
    and (select app.has_permission(expense_categories.tenant_id, 'expenses.approve'))
  );

alter table expenses enable row level security;
alter table expenses force row level security;

create policy expenses_select on expenses
  for select to authenticated
  using (
    (select app.can_read(expenses.tenant_id, 'expenses.view', expenses.branch_id))
  );

create policy expenses_insert on expenses
  for insert to authenticated
  with check (
    (select app.can_write_tenant(expenses.tenant_id))
    and (select app.can_access_branch(expenses.branch_id))
    and (select app.has_permission(expenses.tenant_id, 'expenses.create', expenses.branch_id))
    -- You record an expense as yourself. Attributing one to a colleague is how a
    -- fraudulent expense acquires someone else's name.
    and created_by = (select app.current_user_id())
  );

-- Approving is a separate permission from recording, which is the entire control.
create policy expenses_update_approver on expenses
  for update to authenticated
  using (
    (select app.can_write_tenant(expenses.tenant_id))
    and (select app.can_access_branch(expenses.branch_id))
    and (select app.has_permission(expenses.tenant_id, 'expenses.approve', expenses.branch_id))
  )
  with check (
    (select app.can_write_tenant(expenses.tenant_id))
    and (select app.can_access_branch(expenses.branch_id))
  );

-- -----------------------------------------------------------------------------
-- Cash register
-- -----------------------------------------------------------------------------

alter table cash_registers enable row level security;
alter table cash_registers force row level security;

create policy cash_registers_select on cash_registers
  for select to authenticated
  using (
    (select app.can_read_tenant(cash_registers.tenant_id))
    and (select app.can_access_branch(cash_registers.branch_id))
  );

create policy cash_registers_write on cash_registers
  for all to authenticated
  using (
    (select app.can_write_tenant(cash_registers.tenant_id))
    and (select app.has_permission(cash_registers.tenant_id, 'settings.manage'))
  )
  with check (
    (select app.can_write_tenant(cash_registers.tenant_id))
    and (select app.has_permission(cash_registers.tenant_id, 'settings.manage'))
  );

alter table cash_sessions enable row level security;
alter table cash_sessions force row level security;

-- A cashier sees their own sessions. Seeing everyone's variances requires
-- register.view_variance, because a shift's shortfall is sensitive to the person on it.
create policy cash_sessions_select_own on cash_sessions
  for select to authenticated
  using (
    (select app.can_read_tenant(cash_sessions.tenant_id))
    and (select app.can_access_branch(cash_sessions.branch_id))
    and opened_by = (select app.current_user_id())
  );

create policy cash_sessions_select_supervisor on cash_sessions
  for select to authenticated
  using (
    (select app.can_read(cash_sessions.tenant_id, 'register.view_variance', cash_sessions.branch_id))
  );

alter table cash_movements enable row level security;
alter table cash_movements force row level security;

create policy cash_movements_select on cash_movements
  for select to authenticated
  using (
    exists (
      select 1 from cash_sessions s
      where s.id = cash_movements.session_id
        and (select app.can_read_tenant(s.tenant_id))
        and (select app.can_access_branch(s.branch_id))
        and (
          s.opened_by = (select app.current_user_id())
          or (select app.has_permission(s.tenant_id, 'register.view_variance', s.branch_id))
        )
    )
  );

create policy cash_movements_insert on cash_movements
  for insert to authenticated
  with check (
    (select app.can_write_tenant(cash_movements.tenant_id))
    and (select app.can_access_branch(cash_movements.branch_id))
    and (select app.has_permission(cash_movements.tenant_id, 'register.cash_movement', cash_movements.branch_id))
    and performed_by = (select app.current_user_id())
  );

-- -----------------------------------------------------------------------------
-- Audit, sync and notifications
-- -----------------------------------------------------------------------------

alter table audit_logs enable row level security;
alter table audit_logs force row level security;

create policy audit_logs_select on audit_logs
  for select to authenticated
  using (
    audit_logs.tenant_id is not null
    and (select app.can_read(audit_logs.tenant_id, 'audit.view'))
  );

-- No INSERT policy: audit entries are written by transactional functions, and UPDATE and
-- DELETE are refused by trigger for every role including the service role.

alter table idempotency_keys enable row level security;
alter table idempotency_keys force row level security;

-- Purely a server-side mechanism. No policy for `authenticated`: a client that could read
-- these could enumerate other terminals' transactions, and one that could delete them
-- could replay a sale.

alter table sync_conflicts enable row level security;
alter table sync_conflicts force row level security;

create policy sync_conflicts_select on sync_conflicts
  for select to authenticated
  using (
    (select app.can_read(sync_conflicts.tenant_id, 'inventory.view'))
  );

create policy sync_conflicts_update on sync_conflicts
  for update to authenticated
  using (
    (select app.can_write_tenant(sync_conflicts.tenant_id))
    and (select app.has_permission(sync_conflicts.tenant_id, 'inventory.adjust'))
  )
  with check (
    (select app.can_write_tenant(sync_conflicts.tenant_id))
    and (select app.has_permission(sync_conflicts.tenant_id, 'inventory.adjust'))
  );

alter table notifications enable row level security;
alter table notifications force row level security;

create policy notifications_select on notifications
  for select to authenticated
  using (
    (select app.can_read_tenant(notifications.tenant_id))
    and (
      notifications.user_id = (select app.current_user_id())
      or notifications.user_id is null
    )
  );

-- Marking as read is the only permitted change, and only to your own.
create policy notifications_update_own on notifications
  for update to authenticated
  using (notifications.user_id = (select app.current_user_id()))
  with check (notifications.user_id = (select app.current_user_id()));

-- -----------------------------------------------------------------------------
-- Platform tables
--
-- No tenant user reaches these. Access requires a `platform_admins` row, and the
-- subscription tables are additionally readable by the tenant they concern - a business
-- is entitled to see its own plan and payment history.
-- -----------------------------------------------------------------------------

alter table subscription_plans enable row level security;
alter table subscription_plans force row level security;

create policy subscription_plans_select on subscription_plans
  for select to authenticated
  using (is_active or (select app.is_platform_admin()));

alter table subscriptions enable row level security;
alter table subscriptions force row level security;

create policy subscriptions_select on subscriptions
  for select to authenticated
  using (
    (select app.is_platform_admin())
    or (select app.is_tenant_owner(subscriptions.tenant_id))
    or (select app.has_permission(subscriptions.tenant_id, 'settings.manage'))
  );

create policy subscriptions_write_platform on subscriptions
  for all to authenticated
  using ((select app.is_platform_admin()))
  with check ((select app.is_platform_admin()));

alter table subscription_payments enable row level security;
alter table subscription_payments force row level security;

create policy subscription_payments_select on subscription_payments
  for select to authenticated
  using (
    (select app.is_platform_admin())
    or (select app.is_tenant_owner(subscription_payments.tenant_id))
    or (select app.has_permission(subscription_payments.tenant_id, 'settings.manage'))
  );

create policy subscription_payments_insert_platform on subscription_payments
  for insert to authenticated
  with check ((select app.is_platform_admin()));

alter table installations enable row level security;
alter table installations force row level security;

create policy installations_select_platform on installations
  for select to authenticated
  using ((select app.is_platform_admin()));

create policy installations_write_platform on installations
  for all to authenticated
  using ((select app.is_platform_admin()))
  with check ((select app.is_platform_admin()));

alter table maintenance_records enable row level security;
alter table maintenance_records force row level security;

create policy maintenance_select_platform on maintenance_records
  for select to authenticated
  using ((select app.is_platform_admin()));

-- A tenant may see and raise tickets about its own installation.
create policy maintenance_select_tenant on maintenance_records
  for select to authenticated
  using ((select app.is_tenant_member(maintenance_records.tenant_id)));

create policy maintenance_write_platform on maintenance_records
  for all to authenticated
  using ((select app.is_platform_admin()))
  with check ((select app.is_platform_admin()));

alter table tenant_support_grants enable row level security;
alter table tenant_support_grants force row level security;

-- A customer can see exactly who was granted access to their data, when, and why. That
-- transparency is the point of the mechanism.
create policy support_grants_select_tenant on tenant_support_grants
  for select to authenticated
  using (
    (select app.is_tenant_owner(tenant_support_grants.tenant_id))
    or (select app.has_permission(tenant_support_grants.tenant_id, 'settings.manage'))
  );

create policy support_grants_select_platform on tenant_support_grants
  for select to authenticated
  using ((select app.is_platform_admin()));

-- Grants are issued by an audited server-side operation, not by a client insert.
