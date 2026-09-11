-- =============================================================================
-- 0040 · A business adds its own tills, and product images isolated per business
--
-- ## Terminals
--
-- A Windows POS is bound to a business by a one-time activation code, and issuing a code
-- needs a terminal to issue it for. Nothing created one: no function, no screen, only tests
-- inserting rows by hand. So "install Carl on my till" had no path for a client to take.
-- `register_device` is that path, guarded like every other write: signed in, the business
-- writable, `devices.manage` at that branch, and the branch within the caller's reach.
-- The terminal is created PENDING; it is bound to a machine only when activate_device
-- consumes a code, and the tenant it belongs to is decided here, server-side, never by the
-- installed application.
--
-- ## Product images
--
-- Images are optional. When a product has one it lives in a private bucket at
--
--     {tenant_id}/products/{product_id}/{random uuid}.{jpg|png|webp}
--
-- and every rule about it is enforced in the database:
--
--   * products.image_path may only point inside that product's own folder (CHECK).
--   * Reading an object requires products.view in the business its path names.
--   * Writing, replacing or deleting one requires products.update there, the business being
--     writable, and the product in the path really belonging to that business.
--   * The bucket is private: files are served only through short-lived signed URLs, which
--     Storage issues only to a caller these policies allow to read the object.
--   * Size (2 MB) and type (JPEG, PNG, WebP) are enforced by Storage itself.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- register_device
-- -----------------------------------------------------------------------------
create or replace function register_device(p_branch_id uuid, p_name text)
returns table (device_id uuid, device_code text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_name      text := btrim(coalesce(p_name, ''));
  v_next      integer;
  v_code      text;
  v_id        uuid;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED' using detail = 'Sign in first.';
  end if;

  select b.tenant_id into v_tenant_id
  from public.branches b
  where b.id = p_branch_id and b.is_active;

  -- A branch the caller cannot reach and a branch that does not exist answer the same way.
  if v_tenant_id is null or not app.can_access_branch(p_branch_id) then
    raise exception 'NOT_FOUND' using detail = 'That branch does not exist.';
  end if;
  if not app.can_write_tenant(v_tenant_id) then
    raise exception 'PERMISSION_DENIED' using detail = 'This business cannot be changed right now.';
  end if;
  if not app.has_permission(v_tenant_id, 'devices.manage', p_branch_id) then
    raise exception 'PERMISSION_DENIED' using detail = 'You do not have permission to add terminals.';
  end if;
  if length(v_name) < 2 or length(v_name) > 60 then
    raise exception 'VALIDATION_FAILED' using detail = 'Give the terminal a name of 2 to 60 characters.';
  end if;

  -- Two people adding tills to the same business at once must not draw the same number.
  perform pg_advisory_xact_lock(hashtextextended('register_device:' || v_tenant_id::text, 0));

  select coalesce(max(substring(d.code from '^pos-([0-9]+)$')::integer), 0) + 1
    into v_next
  from public.devices d
  where d.tenant_id = v_tenant_id and d.code ~ '^pos-[0-9]+$';
  v_code := 'pos-' || v_next;

  insert into public.devices (tenant_id, branch_id, code, name)
  values (v_tenant_id, p_branch_id, v_code, v_name)
  returning id into v_id;

  insert into public.audit_logs (tenant_id, actor_id, action, entity_type, entity_id, metadata)
  values (v_tenant_id, auth.uid(), 'DEVICE_REGISTERED', 'device', v_id,
          jsonb_build_object('code', v_code, 'branch_id', p_branch_id));

  return query select v_id, v_code;
end;
$$;

comment on function register_device(uuid, text) is
  'Creates a PENDING terminal at a branch for the caller''s business. Bound to a machine only by activate_device.';

revoke execute on function register_device(uuid, text) from public, anon;
grant execute on function register_device(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Product images: the column and its namespace
-- -----------------------------------------------------------------------------
alter table public.products add column if not exists image_path text;

alter table public.products add constraint products_image_path_own_folder check (
  image_path is null
  or image_path ~ ('^' || tenant_id::text || '/products/' || id::text
                   || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$')
);

comment on column public.products.image_path is
  'Storage path of the product image in the private product-images bucket, or null. Always inside {tenant_id}/products/{id}/.';

-- -----------------------------------------------------------------------------
-- Helpers for the storage policies
-- -----------------------------------------------------------------------------
create or replace function app.uuid_or_null(p_value text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return p_value::uuid;
  end if;
  return null;
end;
$$;

/*
 * Whether the caller may write this object name in the product-images bucket.
 *
 * SECURITY DEFINER only so the product lookup is not itself filtered by RLS; the answer is
 * still about the caller, because has_permission and can_write_tenant read auth.uid().
 */
create or replace function app.product_image_writable(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(array_length(string_to_array(p_name, '/'), 1), 0) = 4
    and split_part(p_name, '/', 2) = 'products'
    and split_part(p_name, '/', 4) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
    and exists (
      select 1 from public.products p
      where p.id = app.uuid_or_null(split_part(p_name, '/', 3))
        and p.tenant_id = app.uuid_or_null(split_part(p_name, '/', 1))
    )
    and app.can_write_tenant(app.uuid_or_null(split_part(p_name, '/', 1)))
    and app.has_permission(app.uuid_or_null(split_part(p_name, '/', 1)), 'products.update')
$$;

revoke execute on function app.uuid_or_null(text) from public, anon;
revoke execute on function app.product_image_writable(text) from public, anon;
grant execute on function app.uuid_or_null(text) to authenticated, service_role;
grant execute on function app.product_image_writable(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- The bucket and its policies
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', false, 2097152,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy product_images_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'product-images'
    and (storage.foldername(name))[2] = 'products'
    and app.can_read(app.uuid_or_null((storage.foldername(name))[1]), 'products.view')
  );

create policy product_images_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-images' and app.product_image_writable(name));

create policy product_images_update on storage.objects
  for update to authenticated
  using (bucket_id = 'product-images' and app.product_image_writable(name))
  with check (bucket_id = 'product-images' and app.product_image_writable(name));

create policy product_images_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'product-images' and app.product_image_writable(name));


-- -----------------------------------------------------------------------------
-- A till sells only at its own branch
--
-- app.authorize_device proves a terminal's secret, status and offline window, and nothing
-- checked that the terminal belonged to the branch a sale was recorded at. Someone who works
-- for two businesses could sign in on business A's till and record a sale at business B's
-- branch, attributed to A's terminal; a till could likewise sell for another branch of its
-- own business. With installed Windows tills on real counters that is not theoretical.
--
-- Enforced twice, for two different reasons:
--   * on sales itself, so it holds for every path that records a sale (sync, a direct
--     complete_sale call, anything written later), and
--   * at the top of sync_offline_sale, so a mismatched till is a hard stop that writes
--     nothing, not even a "conflict for review" filed into the other business.
-- -----------------------------------------------------------------------------
create or replace function app.assert_sale_device_in_branch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.device_id is not null and not exists (
    select 1 from public.devices d
    where d.id = new.device_id
      and d.tenant_id = new.tenant_id
      and d.branch_id = new.branch_id
  ) then
    raise exception 'FORBIDDEN_BRANCH' using detail = 'This terminal belongs to another branch.';
  end if;
  return new;
end;
$$;

revoke execute on function app.assert_sale_device_in_branch() from public, anon;

create trigger sales_device_in_own_branch
  before insert or update of device_id, branch_id, tenant_id on public.sales
  for each row execute function app.assert_sale_device_in_branch();

create or replace function sync_offline_sale(
  p_branch_id       uuid,
  p_items           jsonb,
  p_payments        jsonb,
  p_idempotency_key text,
  p_sold_at         timestamptz,
  p_device_id       uuid,
  p_device_secret   text,
  p_pepper          text,
  p_customer_id     uuid default null,
  p_tier            price_tier default 'RETAIL',
  p_order_discount_type  discount_type default 'NONE',
  p_order_discount_value numeric default null,
  p_note            text default null
)
returns table (
  sale_id       uuid,
  sale_number   text,
  total         bigint,
  was_replayed  boolean,
  had_conflict  boolean,
  conflict_id   uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id   uuid;
  v_result      record;
  v_conflict_id uuid;
  v_message     text;
  v_detail      text;
  v_code        text;
begin
  -- The business comes from the terminal, never from the branch the request names, and the
  -- terminal must belong to that branch. Checked before anything else so a mismatched till
  -- stops here and writes nothing anywhere.
  select d.tenant_id into v_tenant_id
  from public.devices d
  where d.id = p_device_id and d.branch_id = p_branch_id;
  if not found then
    raise exception 'FORBIDDEN_BRANCH' using detail = 'This terminal does not belong to that branch.';
  end if;

  if p_sold_at is null then
    raise exception 'SYNC_PAYLOAD_INVALID'
      using detail = 'An offline sale must carry the time it was made.';
  end if;

  if p_sold_at > now() + interval '1 hour' then
    raise exception 'SYNC_PAYLOAD_INVALID'
      using detail = 'This sale is dated in the future. Check the terminal clock.';
  end if;

  begin
    select * into v_result
    from public.complete_sale(
      p_branch_id, p_items, p_payments, p_idempotency_key, p_customer_id, p_tier,
      p_device_id, p_device_secret, p_pepper,
      p_order_discount_type, p_order_discount_value, null, p_note, p_sold_at, 'POS'
    );

    update public.devices
       set last_sync_at = now(),
           last_seen_at = now(),
           authorized_until = now() + make_interval(hours => offline_grace_hours),
           pending_sync_count = greatest(pending_sync_count - 1, 0)
     where id = p_device_id;

    return query
      select v_result.sale_id, v_result.sale_number, v_result.total,
             v_result.was_replayed, false, null::uuid;
    return;

  exception
    when others then
      get stacked diagnostics
        v_message = message_text,
        v_detail  = pg_exception_detail;

      v_code := split_part(v_message, ' ', 1);

      if v_code in ('DEVICE_REVOKED', 'DEVICE_NOT_ACTIVATED', 'DEVICE_AUTHORIZATION_EXPIRED',
                    'DEVICE_NOT_FOUND', 'TENANT_SUSPENDED', 'PERMISSION_DENIED', 'FORBIDDEN_BRANCH') then
        raise;
      end if;

      insert into public.sync_conflicts (
        tenant_id, branch_id, device_id, conflict_type, entity_type, payload, detail, occurred_at
      )
      values (
        v_tenant_id, p_branch_id, p_device_id,
        case v_code
          when 'INSUFFICIENT_STOCK'  then 'INSUFFICIENT_STOCK'::public.sync_conflict_type
          when 'PRODUCT_NOT_FOUND'   then 'PRODUCT_REMOVED'::public.sync_conflict_type
          when 'PRODUCT_INACTIVE'    then 'PRODUCT_REMOVED'::public.sync_conflict_type
          when 'PRICE_NOT_CONFIGURED' then 'PRICE_CHANGED'::public.sync_conflict_type
          when 'IDEMPOTENCY_KEY_REUSED' then 'DUPLICATE_TRANSACTION'::public.sync_conflict_type
          else 'VALIDATION_FAILED'::public.sync_conflict_type
        end,
        'sale',
        jsonb_build_object(
          'branch_id', p_branch_id,
          'items', p_items,
          'payments', p_payments,
          'idempotency_key', p_idempotency_key,
          'sold_at', p_sold_at,
          'tier', p_tier,
          'customer_id', p_customer_id
        ),
        coalesce(v_detail, v_message),
        p_sold_at
      )
      returning id into v_conflict_id;

      insert into public.notifications (tenant_id, branch_id, kind, severity, title, body, metadata)
      values (
        v_tenant_id, p_branch_id, 'SYNC_CONFLICT', 'WARNING',
        'An offline sale needs review',
        coalesce(v_detail, v_message),
        jsonb_build_object('conflict_id', v_conflict_id, 'device_id', p_device_id)
      );

      update public.devices
         set last_sync_at = now(), last_seen_at = now()
       where id = p_device_id;

      return query
        select null::uuid, null::text, null::bigint, false, true, v_conflict_id;
      return;
  end;
end;
$$;
