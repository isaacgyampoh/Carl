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
