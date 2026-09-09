-- =============================================================================
-- 0023 · Offline synchronisation
--
-- ## The situation this handles
--
-- Two terminals lose connectivity while a branch holds 10 units of a product. One sells
-- 8, the other sells 7. Both cashiers took money and handed over goods; both transactions
-- are legitimate from the terminal's point of view. Hours later both arrive at the server.
--
-- Carl must not pretend 15 units existed. It also must not discard the second sale — the
-- customer paid and left with the goods, and deleting the record does not un-sell them.
--
-- ## What Carl does
--
-- The sale is recorded, the stock goes to whatever the ledger says it goes to, and a
-- `sync_conflicts` row is raised for a human. Someone must decide whether the count was
-- wrong, whether an item was oversold and must be sourced, or whether a refund is owed.
-- That decision is a business decision and the software should not make it silently.
--
-- The alternative designs are both worse:
--
--   * Reject the second sale. The terminal has already printed a receipt and the customer
--     has gone. The shop is left with money it cannot account for.
--   * Accept it silently. Stock goes negative or is quietly corrected, and the shop
--     discovers at stock-take that its inventory has been wrong for a month.
--
-- ## Ordering
--
-- Offline sales carry the time they were actually made. They are applied in that order,
-- so a sale made at 09:00 and synced at 17:00 lands before one made at 10:00 — which
-- matters for the running balance recorded on each ledger movement.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- sync_offline_sale
--
-- Wraps complete_sale rather than duplicating it. Every rule — price resolution, payment
-- validation, permission checks, receipt numbering — is the same one an online sale goes
-- through. A separate offline path would drift, and the drift would only show up in the
-- transactions nobody watched happen.
-- -----------------------------------------------------------------------------

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
  select b.tenant_id into v_tenant_id from public.branches b where b.id = p_branch_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'Branch not found.';
  end if;

  if p_sold_at is null then
    raise exception 'SYNC_PAYLOAD_INVALID'
      using detail = 'An offline sale must carry the time it was made.';
  end if;

  -- A sale claiming to be from the future is a clock problem on the terminal, and
  -- accepting it would put revenue in a day that has not happened.
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

    -- Success. Refresh the terminal's offline authorisation window: it has just proved it
    -- can reach the server and is still trusted.
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
    -- Only business-rule failures become conflicts. A revoked device or a suspended
    -- tenant is a hard stop and must propagate: recording those as "needs review" would
    -- let a stolen terminal keep filing sales for someone to rubber-stamp.
    when others then
      get stacked diagnostics
        v_message = message_text,
        v_detail  = pg_exception_detail;

      v_code := split_part(v_message, ' ', 1);

      if v_code in ('DEVICE_REVOKED', 'DEVICE_NOT_ACTIVATED', 'DEVICE_AUTHORIZATION_EXPIRED',
                    'TENANT_SUSPENDED', 'PERMISSION_DENIED', 'FORBIDDEN_BRANCH') then
        raise;
      end if;

      -- Everything else is recorded for review rather than lost. The payload is kept
      -- verbatim so a reviewer sees what the cashier actually did, not an interpretation.
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

comment on function sync_offline_sale is
  'Applies an offline sale through complete_sale. Business-rule failures become reviewable conflicts; device and tenant failures are hard stops.';

revoke execute on function sync_offline_sale from public, anon;
grant execute on function sync_offline_sale to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- device_sync_state
--
-- What a terminal asks for when it reconnects: am I still allowed to trade, and how much
-- of the catalogue has changed since I last looked?
-- -----------------------------------------------------------------------------

create or replace function device_sync_state(
  p_device_id     uuid,
  p_device_secret text,
  p_pepper        text
)
returns table (
  tenant_id        uuid,
  branch_id        uuid,
  authorized_until timestamptz,
  server_time      timestamptz,
  catalogue_version timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device record;
begin
  perform app.authorize_device(p_device_id, p_device_secret, p_pepper);

  select d.* into v_device from public.devices d where d.id = p_device_id;

  update public.devices
     set last_seen_at = now(),
         authorized_until = now() + make_interval(hours => v_device.offline_grace_hours)
   where id = p_device_id;

  return query
    select
      v_device.tenant_id,
      v_device.branch_id,
      now() + make_interval(hours => v_device.offline_grace_hours),
      now(),
      -- The terminal compares this against what it last downloaded to decide whether its
      -- local catalogue is stale, without pulling the whole thing every time.
      coalesce(
        (select max(greatest(p.updated_at, coalesce(pp.created_at, p.updated_at)))
         from public.products p
         left join public.product_prices pp on pp.product_id = p.id
         where p.tenant_id = v_device.tenant_id),
        now()
      );
end;
$$;

revoke execute on function device_sync_state(uuid, text, text) from public, anon;
grant execute on function device_sync_state(uuid, text, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- resolve_sync_conflict
-- -----------------------------------------------------------------------------

create or replace function resolve_sync_conflict(
  p_conflict_id uuid,
  p_resolution  sync_conflict_status,
  p_note        text
)
returns table (resolved_conflict_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conflict record;
begin
  select c.* into v_conflict from public.sync_conflicts c where c.id = p_conflict_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'Conflict not found.';
  end if;

  if not app.has_permission(v_conflict.tenant_id, 'inventory.adjust', v_conflict.branch_id) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if p_resolution not in ('RESOLVED', 'DISMISSED', 'ACKNOWLEDGED') then
    raise exception 'VALIDATION_FAILED' using detail = 'That is not a resolution.';
  end if;

  -- A dismissed conflict is a decision someone made, and the reason has to survive so it
  -- can be questioned later.
  if p_resolution in ('RESOLVED', 'DISMISSED')
     and (p_note is null or length(btrim(p_note)) < 3) then
    raise exception 'VALIDATION_FAILED'
      using detail = 'Record how this was resolved before closing it.';
  end if;

  update public.sync_conflicts
     set status = p_resolution,
         resolved_by = auth.uid(),
         resolved_at = case when p_resolution = 'ACKNOWLEDGED' then null else now() end,
         resolution_note = p_note
   where id = p_conflict_id;

  insert into public.audit_logs
    (tenant_id, branch_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_conflict.tenant_id, v_conflict.branch_id, auth.uid(),
    'SYNC_CONFLICT_RESOLVED', 'sync_conflict', p_conflict_id,
    jsonb_build_object('resolution', p_resolution, 'note', p_note)
  );

  return query select p_conflict_id;
end;
$$;

revoke execute on function resolve_sync_conflict(uuid, sync_conflict_status, text) from public, anon;
grant execute on function resolve_sync_conflict(uuid, sync_conflict_status, text) to authenticated, service_role;
