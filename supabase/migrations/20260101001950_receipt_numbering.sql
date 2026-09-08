-- =============================================================================
-- 0019b · Receipt numbering
--
-- ## Why not a sequence
--
-- A PostgreSQL sequence is global and gapless-per-instance, which is the wrong shape:
-- two branches would share one series, so a shop's receipt numbers would jump whenever
-- another branch traded, and customers would notice. Worse, sequences do not roll back —
-- a failed sale would consume a number and leave a permanent gap that looks, to an
-- auditor, exactly like a deleted receipt.
--
-- ## Why not a client-generated number
--
-- An offline terminal cannot know what the server or its sibling tills have issued.
-- Letting each device count for itself guarantees collisions on sync, and the collision
-- surfaces days later as two receipts with the same number.
--
-- ## What Carl does
--
-- The number is composed per branch and per day:
--
--     <BRANCH CODE>-<YYMMDD>-<NNNN>
--     ACCRA-260908-0042
--
-- The counter is derived by counting that branch's sales for that day inside the same
-- transaction as the sale itself, under the row lock the sale already holds on the
-- branch. Two concurrent sales therefore serialise, and a rolled-back sale releases its
-- number rather than burning it.
--
-- Uniqueness is guaranteed by the `sales_branch_number_key` index, not by this function:
-- if the derivation were ever wrong, the insert fails rather than producing a duplicate.
-- =============================================================================

create or replace function app.next_sale_number(
  p_branch_id uuid,
  p_at        timestamptz default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch   record;
  v_local    timestamptz;
  v_day      date;
  v_sequence integer;
  v_timezone text;
begin
  select b.code, b.tenant_id, b.timezone into v_branch
  from public.branches b
  where b.id = p_branch_id
  -- Serialises number allocation for this branch. Two tills completing a sale in the same
  -- millisecond queue here rather than deriving the same counter.
  for update;

  if not found then
    raise exception 'NOT_FOUND' using detail = 'Branch not found.';
  end if;

  -- The branch's own local day. A shop trading past midnight UTC would otherwise see its
  -- receipt numbers reset in the middle of the evening.
  v_timezone := coalesce(
    v_branch.timezone,
    (select t.timezone from public.tenants t where t.id = v_branch.tenant_id),
    'UTC'
  );
  v_local := coalesce(p_at, now());
  v_day := (v_local at time zone v_timezone)::date;

  select count(*) + 1 into v_sequence
  from public.sales s
  where s.branch_id = p_branch_id
    and (s.sold_at at time zone v_timezone)::date = v_day;

  return upper(v_branch.code) || '-' || to_char(v_day, 'YYMMDD') || '-' || lpad(v_sequence::text, 4, '0');
end;
$$;

comment on function app.next_sale_number(uuid, timestamptz) is
  'Composes BRANCH-YYMMDD-NNNN under a branch row lock. Uniqueness is guaranteed by the index, not by this.';
