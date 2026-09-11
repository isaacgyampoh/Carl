-- The one table a session could hold privileges on and never need them.
--
-- `idempotency_keys` is what stops a sale being recorded twice when a till retries. Row Level
-- Security is forced on it and it has no policy, so a session is already refused — but
-- `authenticated` still held SELECT, INSERT, UPDATE and DELETE on it, which is a grant nobody
-- uses and a surprise waiting for whoever next adds a policy "to make it work".
--
-- Nothing in the application touches this table: every write comes from `complete_sale`,
-- `process_return`, `void_sale` and the platform operations, all SECURITY DEFINER functions
-- that run as their owner. Taking the grants away changes no behaviour and removes the gap
-- between what a session may do and what it needs.
--
-- Found by an audit of "every public table has at least one policy": the honest answer for this
-- table is that it should have no policy AND no grant.

revoke all on public.idempotency_keys from authenticated, anon;

comment on table public.idempotency_keys is
  'Retry keys, written only by SECURITY DEFINER functions. No policy and no grant: a session has no business here.';
