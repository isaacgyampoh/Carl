-- =============================================================================
-- Development seed data.
--
-- ## This is NOT production data
--
-- Every account here uses a well-known password and every tenant is named so it cannot be
-- mistaken for a real customer. Loading this into a production database would create
-- working logins that anyone reading this repository knows the credentials for.
--
-- The guard below refuses to run unless the database already looks empty, which stops the
-- most likely accident: running `supabase db reset` against the wrong project.
--
-- Load with:  psql "$SUPABASE_DB_URL" -f supabase/seed/seed.sql
-- =============================================================================

do $$
begin
  if exists (select 1 from public.tenants limit 1) then
    raise exception 'REFUSING_TO_SEED'
      using detail = 'This database already contains tenants. Seed data is for an empty development database only.';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Accounts
--
-- On a real Supabase project these are created through the Auth admin API; here they are
-- inserted directly so the seed works against a bare database too.
-- -----------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000000a', 'platform@carl.test'),
  ('00000000-0000-4000-8000-00000000000b', 'owner@demo.test'),
  ('00000000-0000-4000-8000-00000000000c', 'manager@demo.test'),
  ('00000000-0000-4000-8000-00000000000d', 'cashier@demo.test'),
  ('00000000-0000-4000-8000-00000000000e', 'accountant@demo.test')
on conflict (id) do nothing;

insert into public.profiles (id, email, full_name) values
  ('00000000-0000-4000-8000-00000000000a', 'platform@carl.test',   'Carl Platform Admin'),
  ('00000000-0000-4000-8000-00000000000b', 'owner@demo.test',      'Ama Mensah'),
  ('00000000-0000-4000-8000-00000000000c', 'manager@demo.test',    'Kofi Boateng'),
  ('00000000-0000-4000-8000-00000000000d', 'cashier@demo.test',    'Akosua Owusu'),
  ('00000000-0000-4000-8000-00000000000e', 'accountant@demo.test', 'Yaw Darko')
on conflict (id) do nothing;

insert into public.platform_admins (user_id, note) values
  ('00000000-0000-4000-8000-00000000000a', 'Seeded development platform administrator')
on conflict (user_id) do nothing;

-- -----------------------------------------------------------------------------
-- A demo business
--
-- Provisioned through the real function, so the seeded tenant is shaped exactly like one
-- created in production — same system roles, same permissions, same owner membership.
-- -----------------------------------------------------------------------------

do $$
declare
  v_tenant_id uuid;
  v_accra_id  uuid;
  v_kumasi_id uuid;
  v_tema_id   uuid;
  v_product   record;
  v_product_id uuid;
  v_membership uuid;
  v_role_id   uuid;
begin
  -- provision_tenant() requires a platform administrator, so act as the seeded one.
  perform set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}',
    true
  );

  select tenant_id, branch_id into v_tenant_id, v_accra_id
  from public.provision_tenant(
    'demo-trading',
    'Demo Trading Company',
    'owner@demo.test',
    'Ama Mensah',
    '00000000-0000-4000-8000-00000000000b',
    'Accra Branch',
    'accra',
    'ACTIVE',
    14
  );

  insert into public.branches (tenant_id, code, name, address)
  values (v_tenant_id, 'kumasi', 'Kumasi Branch', 'Adum, Kumasi')
  returning id into v_kumasi_id;

  insert into public.branches (tenant_id, code, name, address)
  values (v_tenant_id, 'tema', 'Tema Branch', 'Community 1, Tema')
  returning id into v_tema_id;

  insert into public.cash_registers (tenant_id, branch_id, name) values
    (v_tenant_id, v_kumasi_id, 'Main Register'),
    (v_tenant_id, v_tema_id,   'Main Register');

  -- Staff, each on a different role so the permission boundaries are visible immediately.
  for v_product in
    select * from (values
      ('00000000-0000-4000-8000-00000000000c'::uuid, 'branch_manager', 'Branch Manager'),
      ('00000000-0000-4000-8000-00000000000d'::uuid, 'cashier',        'Cashier'),
      ('00000000-0000-4000-8000-00000000000e'::uuid, 'accountant',     'Accountant')
    ) as s(user_id, role_key, job_title)
  loop
    insert into public.tenant_memberships (tenant_id, user_id, status, accepted_at, job_title)
    values (v_tenant_id, v_product.user_id, 'ACTIVE', now(), v_product.job_title)
    returning id into v_membership;

    select id into v_role_id
    from public.roles where tenant_id = v_tenant_id and key = v_product.role_key;

    insert into public.membership_roles (membership_id, role_id) values (v_membership, v_role_id);
  end loop;

  -- The cashier works only in Accra, which demonstrates branch scoping.
  insert into public.membership_branches (membership_id, branch_id)
  select m.id, v_accra_id
  from public.tenant_memberships m
  where m.tenant_id = v_tenant_id and m.user_id = '00000000-0000-4000-8000-00000000000d';

  -- Categories
  insert into public.categories (tenant_id, name) values
    (v_tenant_id, 'Beverages'),
    (v_tenant_id, 'Staples'),
    (v_tenant_id, 'Household'),
    (v_tenant_id, 'Snacks');

  -- Products, with prices and opening stock at Accra.
  for v_product in
    select * from (values
      ('Coca-Cola 500ml',      'COKE-500',  'bottle', 500,    350,  120),
      ('Voltic Water 750ml',   'WATER-750', 'bottle', 350,    220,  200),
      ('Rice 5kg',             'RICE-5KG',  'bag',    6500,   4800, 40),
      ('Cooking Oil 1L',       'OIL-1L',    'bottle', 2200,   1600, 60),
      ('Milo Tin 400g',        'MILO-400',  'tin',    4500,   3400, 35),
      ('Sugar 1kg',            'SUGAR-1KG', 'bag',    1800,   1300, 80),
      ('Washing Powder 900g',  'WASH-900',  'pack',   2800,   2000, 25),
      ('Tissue Roll 10pk',     'TISS-10',   'pack',   3200,   2300, 30),
      ('Biscuits 200g',        'BISC-200',  'pack',   900,    600,  150),
      ('Tomato Paste 400g',    'TOM-400',   'tin',    1200,   850,  90)
    ) as p(name, sku, unit, retail, cost, qty)
  loop
    insert into public.products
      (tenant_id, name, sku, unit, average_cost, last_cost, reorder_level, tax_mode, tax_rate)
    values
      (v_tenant_id, v_product.name, v_product.sku, v_product.unit,
       v_product.cost, v_product.cost, 20, 'INCLUSIVE', 15)
    returning id into v_product_id;

    insert into public.product_prices (tenant_id, product_id, tier, amount)
    values (v_tenant_id, v_product_id, 'RETAIL', v_product.retail);

    -- A wholesale tier at roughly 12% off, with a break at ten units.
    insert into public.product_prices (tenant_id, product_id, tier, amount, min_quantity)
    values (v_tenant_id, v_product_id, 'WHOLESALE', round(v_product.retail * 0.88), 10);

    insert into public.inventory (tenant_id, branch_id, product_id, quantity, reorder_level)
    values (v_tenant_id, v_accra_id, v_product_id, v_product.qty, 20);

    insert into public.inventory_movements
      (tenant_id, branch_id, product_id, movement_type, quantity, balance_after, unit_cost, reason)
    values
      (v_tenant_id, v_accra_id, v_product_id, 'OPENING_STOCK', v_product.qty, v_product.qty,
       v_product.cost, 'Seeded opening stock');
  end loop;

  -- Customers
  insert into public.customers (tenant_id, name, phone, default_tier) values
    (v_tenant_id, 'Grace Adjei',       '0244000001', 'RETAIL'),
    (v_tenant_id, 'Nana Wholesale Ltd', '0244000002', 'WHOLESALE'),
    (v_tenant_id, 'Kwame Asante',      '0244000003', 'RETAIL');

  -- Suppliers
  insert into public.suppliers (tenant_id, name, contact_name, phone, payment_terms_days) values
    (v_tenant_id, 'Accra Distributors', 'Mr Tetteh', '0302000001', 30),
    (v_tenant_id, 'Ghana Beverages',    'Ms Amoah',  '0302000002', 14);

  -- Expense categories
  insert into public.expense_categories (tenant_id, name) values
    (v_tenant_id, 'Utilities'),
    (v_tenant_id, 'Transport'),
    (v_tenant_id, 'Rent'),
    (v_tenant_id, 'Supplies');

  -- A terminal, left PENDING so the activation flow can be exercised end to end.
  insert into public.devices (tenant_id, branch_id, code, name) values
    (v_tenant_id, v_accra_id, 'pos-accra-001', 'Accra Till 1'),
    (v_tenant_id, v_kumasi_id, 'pos-kumasi-001', 'Kumasi Till 1');

  perform set_config('request.jwt.claims', '', true);
end
$$;

-- -----------------------------------------------------------------------------
-- A second business
--
-- Exists so tenant isolation is visible while developing: sign in as one owner and the
-- other's data is simply not there.
-- -----------------------------------------------------------------------------

do $$
declare
  v_tenant_id uuid;
  v_branch_id uuid;
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}',
    true
  );

  insert into auth.users (id, email) values
    ('00000000-0000-4000-8000-00000000001a', 'owner@other.test')
  on conflict (id) do nothing;

  insert into public.profiles (id, email, full_name) values
    ('00000000-0000-4000-8000-00000000001a', 'owner@other.test', 'Second Business Owner')
  on conflict (id) do nothing;

  select tenant_id, branch_id into v_tenant_id, v_branch_id
  from public.provision_tenant(
    'other-shop',
    'Other Shop Limited',
    'owner@other.test',
    'Second Business Owner',
    '00000000-0000-4000-8000-00000000001a',
    'Main Branch',
    'main',
    'ACTIVE',
    14
  );

  insert into public.products (tenant_id, name, sku, unit)
  values (v_tenant_id, 'Confidential Product', 'SECRET-1', 'unit');

  perform set_config('request.jwt.claims', '', true);
end
$$;

-- -----------------------------------------------------------------------------
-- Subscription plans
-- -----------------------------------------------------------------------------

insert into public.subscription_plans (key, name, description, price, interval, max_branches, max_devices, max_users, sort_order)
values
  ('starter',  'Starter',  'One branch, two terminals.',        15000,  'MONTHLY', 1,    2,    5,    1),
  ('standard', 'Standard', 'Up to five branches.',              45000,  'MONTHLY', 5,    15,   30,   2),
  ('business', 'Business', 'Unlimited branches and terminals.', 120000, 'MONTHLY', null, null, null, 3)
on conflict (key) do nothing;
