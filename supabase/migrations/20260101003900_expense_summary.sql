-- =============================================================================
-- 0039 · expense_summary — what the business spent over a period
--
-- Reports showed sales, cost of sales and gross profit, but not what the business spent,
-- so no screen could answer "did we make money this month". This aggregates expenses the
-- way sales_summary aggregates sales: in PostgreSQL, as the caller, one row back.
--
-- ## Who sees what
--
-- SECURITY INVOKER. RLS on `expenses` (expenses.view, per branch) decides which rows are
-- counted, so this aggregate cannot see further than the expenses list itself. A caller
-- without expenses.view gets zeroes, not the business's spending; a branch-scoped caller
-- gets their branch's.
--
-- ## What counts
--
-- APPROVED and PAID are expenses. PENDING_APPROVAL is reported on its own: money nobody
-- has yet agreed was spent is not yet an expense, but an owner should see it waiting.
-- DRAFT and REJECTED are neither.
--
-- ## The range
--
-- Half-open over `expense_date`, the date the expense belongs to rather than when it was
-- keyed in, so a receipt entered on the 2nd still lands in the previous month.
-- =============================================================================

create or replace function expense_summary(
  p_tenant_id uuid,
  p_from      timestamptz,
  p_to        timestamptz,
  p_branch_id uuid default null
)
returns table (
  expense_count bigint,
  total         bigint,
  pending_count bigint,
  pending_total bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    count(*) filter (where e.status in ('APPROVED', 'PAID')),
    coalesce(sum(e.amount) filter (where e.status in ('APPROVED', 'PAID')), 0)::bigint,
    count(*) filter (where e.status = 'PENDING_APPROVAL'),
    coalesce(sum(e.amount) filter (where e.status = 'PENDING_APPROVAL'), 0)::bigint
  from public.expenses e
  where e.tenant_id = p_tenant_id
    and (p_branch_id is null or e.branch_id = p_branch_id)
    and e.expense_date >= p_from::date
    and e.expense_date < p_to::date
$$;

comment on function expense_summary(uuid, timestamptz, timestamptz, uuid) is
  'Approved and pending expenses over a half-open date range, as the caller (RLS applies).';

revoke execute on function expense_summary(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function expense_summary(uuid, timestamptz, timestamptz, uuid) to authenticated, service_role;
