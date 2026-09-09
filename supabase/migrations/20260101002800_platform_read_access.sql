-- =============================================================================
-- 0028 · Platform read access
--
-- The platform owner operates Carl commercially: onboarding businesses, issuing
-- activations, chasing subscriptions. Doing that without a database client requires
-- reading five tables the control plane currently cannot see at all.
--
-- ## What this deliberately does NOT do
--
-- It grants SELECT and nothing else, on structural and operational records only. It does
-- not grant a single row of any merchant's *business* data — no sales, no stock, no
-- takings, no customers, no suppliers, no expenses. Being able to run Carl as a business
-- is not the same as being able to read what a shop sold yesterday, and conflating the two
-- is how a platform operator becomes a privacy incident.
--
-- Reading a customer's business data still requires an explicit, time-boxed
-- `tenant_support_grant` that the customer can see. That boundary is unchanged.
--
-- ## Why SELECT only
--
-- Every platform mutation goes through a SECURITY DEFINER function in migration 0030,
-- which re-checks authorisation, enforces the business rules and writes an audit entry.
-- A blanket write policy would let a mistake in the application skip all three.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- branches — needed for the client profile, the branch list, and to know where a
-- terminal is being activated.
-- -----------------------------------------------------------------------------
create policy branches_select_platform_admin on branches
  for select to authenticated
  using ((select app.is_platform_admin()));

-- -----------------------------------------------------------------------------
-- tenant_memberships and roles — the staff list on a client profile.
--
-- Names and roles only: these tables carry who works for a business and what they may do,
-- not what they did. A support conversation routinely starts with "which of my staff has
-- the manager role", and answering it should not require a database client.
-- -----------------------------------------------------------------------------
create policy tenant_memberships_select_platform_admin on tenant_memberships
  for select to authenticated
  using ((select app.is_platform_admin()));

create policy roles_select_platform_admin on roles
  for select to authenticated
  using ((select app.is_platform_admin()));

-- -----------------------------------------------------------------------------
-- device_activations — the activation history for a terminal.
--
-- The table stores only a peppered SHA-256 hash of each code, never the code itself, so
-- reading it cannot yield a working activation credential. What it yields is what support
-- actually needs: when a code was issued, whether it was consumed, and how many attempts
-- were made against it.
-- -----------------------------------------------------------------------------
create policy device_activations_select_platform_admin on device_activations
  for select to authenticated
  using ((select app.is_platform_admin()));

-- -----------------------------------------------------------------------------
-- audit_logs — the platform activity view.
--
-- Scoped to platform-operated actions and away from a merchant's own trading history. A
-- platform administrator gets the record of what *the platform* did to an account:
-- onboarding, suspension, activation, billing. What a cashier voided last Tuesday is the
-- merchant's business, and reading it goes through a support grant like everything else.
-- -----------------------------------------------------------------------------
create policy audit_logs_select_platform_admin on audit_logs
  for select to authenticated
  using (
    (select app.is_platform_admin())
    and audit_logs.action in (
      'TENANT_PROVISIONED', 'CLIENT_ONBOARDED', 'TENANT_SUSPENDED', 'TENANT_REACTIVATED',
      'SUBSCRIPTION_CREATED', 'SUBSCRIPTION_PAYMENT_RECORDED',
      'INVOICE_ISSUED', 'INVOICE_CANCELLED',
      'DEVICE_REGISTERED', 'DEVICE_ACTIVATION_ISSUED', 'DEVICE_ACTIVATED', 'DEVICE_REVOKED'
    )
  );

comment on policy audit_logs_select_platform_admin on audit_logs is
  'Platform-operated actions only. A merchant''s trading history needs a support grant.';
