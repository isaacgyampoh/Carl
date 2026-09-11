-- Server errors, kept where the owner can see them.
--
-- Nothing told anyone when Carl failed in production. A shop noticing before the platform
-- owner does is how a bad deployment survives an afternoon, so every unhandled server error is
-- recorded here and shown in the console, and a scheduled check reads the same table.
--
-- What is deliberately NOT stored: the error's stack, any request body, any header, any query
-- parameter. A stack trace on a screen is how internal details reach a shopkeeper, and an error
-- store that keeps request payloads becomes a copy of the data it was meant to protect.

create table app_errors (
  id            uuid primary key default extensions.gen_random_uuid(),
  occurred_at   timestamptz not null default now(),
  -- Next.js's own identifier for the error, which also appears in the platform's logs.
  digest        text,
  -- The error's message, truncated. Never the stack.
  message       text not null,
  -- Where it happened: a path, never the query string.
  route         text,
  method        text,
  -- Which application: the owner console, or a business.
  surface       text,
  -- Set only when the failing request already knew them; never guessed.
  tenant_id     uuid references tenants(id) on delete set null,
  user_id       uuid references auth.users(id) on delete set null,
  constraint app_errors_message_bounded check (length(message) between 1 and 2000),
  constraint app_errors_route_bounded check (route is null or length(route) <= 500)
);

comment on table app_errors is
  'Unhandled server errors, for the owner console and the scheduled health check. No stacks, no payloads.';

create index app_errors_recent on app_errors (occurred_at desc);
create index app_errors_tenant on app_errors (tenant_id, occurred_at desc) where tenant_id is not null;

alter table app_errors enable row level security;
alter table app_errors force row level security;

-- Only the platform owner reads them, and nobody writes through a session: the server writes
-- with the service role, which is the only caller that has no user to be filtered by.
create policy app_errors_platform_read on app_errors
  for select using (app.is_platform_admin());

revoke all on app_errors from anon, authenticated;
grant select on app_errors to authenticated;

/*
 * Old errors are noise, and a table nobody trims is a table that eventually holds a year of
 * failures. Thirty days is long enough to see a pattern and short enough to stay small.
 */
create or replace function prune_app_errors()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if not app.is_platform_admin() then
    raise exception 'PERMISSION_DENIED' using detail = 'Only a platform administrator may prune errors.';
  end if;

  delete from public.app_errors where occurred_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function prune_app_errors() from public, anon;
grant execute on function prune_app_errors() to authenticated;
