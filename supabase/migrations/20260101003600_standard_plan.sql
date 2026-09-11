-- =============================================================================
-- 0036 · The standard plan
--
-- ## Why this exists
--
-- Onboarding a customer requires a plan. `subscription_plans` had no seed of any kind:
-- plans were "ordinary data that tests insert", so a real deployment started with none, and
-- the database test harness deliberately truncates the table between runs.
--
-- The consequence reached the owner as a button that did nothing. The onboarding form loads
-- the plan list, defaults the selector to `plans[0]?.id ?? ''`, and validates it as a uuid —
-- so with no plans the form failed its own validation before anything was ever sent. Nothing
-- was broken in the action, the transaction, or the database; there was simply nothing to
-- choose.
--
-- ## One plan, deliberately
--
-- Every customer is on the same terms and payment is collected by hand. This seeds exactly
-- one active plan so onboarding always has a valid answer without asking the owner a question
-- that currently has only one possible response.
--
-- The table keeps its price, interval and limit columns, so introducing real plans later is
-- inserting rows rather than reshaping anything. Nothing here enforces or charges anything:
-- `price` is 0 because Carl does not collect money, and the limits are NULL because no
-- customer is being capped today.
--
-- Idempotent on `key`, so re-running it cannot produce a second standard plan, and a
-- deployment that already has one is left alone.
-- =============================================================================

insert into subscription_plans (key, name, description, price, currency_code, interval,
                                max_branches, max_devices, max_users, is_active, sort_order)
values (
  'standard',
  'Standard',
  'Every Carl customer is on the same terms while payment is collected directly.',
  0,
  'GHS',
  'MONTHLY',
  null, null, null,
  true,
  0
)
on conflict (key) do nothing;

comment on table subscription_plans is
  'Subscription plans. One active "standard" plan today; the columns exist so real plans are an insert rather than a migration.';
