-- =============================================================================
-- 0026 · Attribution on append-only tables must not be a foreign key
--
-- ## The conflict
--
-- `inventory_movements` is append-only: a trigger refuses UPDATE and DELETE, which is what
-- makes the stock ledger worth having. It also carried
--
--     performed_by uuid references profiles (id) on delete set null
--
-- Those two cannot both hold. Deleting a person cascades from `auth.users` to `profiles`,
-- which fires the `SET NULL` — an UPDATE on an append-only table. The trigger refuses it,
-- and the whole delete fails with IMMUTABLE_RECORD.
--
-- The practical effect: **once a member of staff has posted a single stock movement, their
-- account can never be deleted.** That is not a theoretical problem. It blocks an erasure
-- request, and it fails with an error that says nothing about the actual cause.
--
-- `cash_movements.performed_by` and `subscription_payments.recorded_by` have the same
-- shape with ON DELETE RESTRICT, which fails just as hard, only with a foreign-key error
-- instead.
--
-- ## The fix
--
-- Attribution columns on append-only tables become plain `uuid` with no foreign key —
-- exactly what `audit_logs.actor_id` already does, and for exactly the same reason stated
-- there: a departed employee's actions must remain attributable after their profile is
-- gone.
--
-- What is given up is referential integrity on those columns. That is the correct trade:
-- the alternative is a ledger that either mutates (destroying its value) or pins every
-- account that ever touched it (destroying erasure). The id remains meaningful — it can
-- still be joined to `profiles` when the profile exists, and reads as an unknown actor
-- when it does not, which is the truth.
--
-- Found by a test asserting that a departed employee's stock adjustment stays attributable.
-- =============================================================================

alter table inventory_movements
  drop constraint if exists inventory_movements_performed_by_fkey;

comment on column inventory_movements.performed_by is
  'Who posted this movement. Deliberately not a foreign key: this ledger is append-only, so a cascading SET NULL cannot fire, and a departed employee''s movements must stay attributable.';

alter table cash_movements
  drop constraint if exists cash_movements_performed_by_fkey;

comment on column cash_movements.performed_by is
  'Who moved the cash. Not a foreign key, for the same reason as inventory_movements.performed_by.';

alter table subscription_payments
  drop constraint if exists subscription_payments_recorded_by_fkey;

comment on column subscription_payments.recorded_by is
  'Which Carl staff member recorded this payment. Not a foreign key: the record outlives the account.';

-- The columns are still indexed for "what did this person do", which is the query that
-- matters when investigating a discrepancy.
create index if not exists inventory_movements_performed_by_idx
  on inventory_movements (performed_by, occurred_at desc)
  where performed_by is not null;

create index if not exists cash_movements_performed_by_idx
  on cash_movements (performed_by, occurred_at desc);
