/**
 * Building the authenticated caller's context.
 *
 * ## The one rule
 *
 * Every value here is derived from a **verified session** and the **database's own
 * records**. Nothing is read from a request body, a header, a query parameter or a cookie
 * other than the session cookie Supabase itself signs.
 *
 * A caller who edits `tenant_id` in a request changes nothing, because this function never
 * looks there. That is what makes tenant isolation hold even for code paths nobody
 * remembered to check.
 *
 * ## Why `getUser()` and not `getSession()`
 *
 * `getSession()` reads the JWT from the cookie and decodes it **without verifying it
 * against the auth server**. On a server that is not authentication — a forged cookie
 * decodes perfectly well. `getUser()` validates the token with Supabase Auth. The extra
 * round trip is the price of the guarantee.
 */

import 'server-only';

import {
  type AccessibleBranch,
  type AuthContext,
  type AuthenticatedUser,
  type TenantContext,
  TenantStatus,
} from '@carl/application';
import { type Permission } from '@carl/domain';
import { asId, randomUuid } from '@carl/shared';

import type { CarlSupabaseClient } from '../supabase/server-client';

interface MembershipRow {
  tenant_id: string;
  tenants: {
    name: string;
    status: string;
  } | null;
}

interface BranchRow {
  id: string;
  code: string;
  name: string;
}

interface PermissionRow {
  permission_key: string;
}

export interface ResolveOptions {
  /** The branch the session is operating in, if one has been chosen. */
  readonly requestedBranchId?: string | undefined;
  /** The tenant to resolve, when the user belongs to more than one. */
  readonly requestedTenantId?: string | undefined;
  /** Correlates every log line and audit entry for one request. */
  readonly requestId?: string | undefined;
}

/**
 * Resolves the current caller, or null when there is no valid session.
 *
 * Note the treatment of `requestedTenantId` and `requestedBranchId`: they are *filters over
 * what the database already says the user may reach*, never grants. Asking for a tenant you
 * are not a member of yields null, not access.
 */
export async function resolveAuthContext(
  supabase: CarlSupabaseClient,
  options: ResolveOptions = {},
): Promise<AuthContext | null> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return null;

  const authUser = userData.user;

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, email, full_name')
    .eq('id', authUser.id)
    .maybeSingle<{ id: string; email: string; full_name: string }>();

  // A user may be signed in without a Carl profile only during provisioning. Treat that as
  // no context rather than inventing one.
  if (!profile) return null;

  // Platform administration is read from its own table, never from a claim the client
  // could influence.
  const { data: platformAdmin } = await supabase
    .from('platform_admins')
    .select('user_id')
    .eq('user_id', authUser.id)
    .maybeSingle<{ user_id: string }>();

  const user: AuthenticatedUser = {
    userId: asId<'UserId'>(profile.id),
    email: profile.email,
    fullName: profile.full_name,
    isPlatformAdmin: platformAdmin !== null,
  };

  const requestId = options.requestId ?? randomUuid();
  const tenant = await resolveTenant(supabase, options);

  return { user, tenant, deviceId: null, requestId };
}

async function resolveTenant(
  supabase: CarlSupabaseClient,
  options: ResolveOptions,
): Promise<TenantContext | null> {
  // RLS already restricts this to the caller's own memberships, so no user filter is
  // needed — and adding one would imply the filter is what provides the isolation.
  const { data: memberships } = await supabase
    .from('tenant_memberships')
    .select('tenant_id, tenants(name, status)')
    .eq('status', 'ACTIVE')
    .returns<MembershipRow[]>();

  if (!memberships || memberships.length === 0) return null;

  const membership = options.requestedTenantId
    ? memberships.find((m) => m.tenant_id === options.requestedTenantId)
    : memberships[0];

  // Asking for a tenant you do not belong to is not an error worth distinguishing from
  // having no tenant: both mean "no access", and telling them apart confirms the tenant
  // exists.
  if (!membership?.tenants) return null;

  const tenantId = asId<'TenantId'>(membership.tenant_id);

  const [branches, permissions] = await Promise.all([
    accessibleBranches(supabase, membership.tenant_id),
    grantedPermissions(supabase, membership.tenant_id),
  ]);

  // The requested branch is a filter over what the database already permits, never a
  // grant. Asking for a branch you cannot reach falls back to your first one.
  const requested = branches.find((branch) => branch.id === options.requestedBranchId);
  const activeBranchId = requested?.id ?? branches[0]?.id ?? null;

  return {
    tenantId,
    tenantName: membership.tenants.name,
    status: toTenantStatus(membership.tenants.status),
    branches,
    activeBranchId,
    permissions,
  };
}

/**
 * The branches this user may act in.
 *
 * Read straight from `branches` rather than from `membership_branches`, because RLS on
 * `branches` already implements the rule — including the "no assignment means tenant-wide"
 * default. Reimplementing it here would be a second copy that could disagree with the one
 * that actually enforces anything.
 */
async function accessibleBranches(
  supabase: CarlSupabaseClient,
  tenantId: string,
): Promise<readonly AccessibleBranch[]> {
  const { data } = await supabase
    .from('branches')
    .select('id, code, name')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('code')
    .returns<BranchRow[]>();

  return (data ?? []).map((row) => ({
    id: asId<'BranchId'>(row.id),
    code: row.code,
    name: row.name,
  }));
}

/**
 * The permissions this user holds in this tenant.
 *
 * Used only to decide what the UI offers. The database checks the same permissions again on
 * every operation, so a stale or tampered set here changes what is *displayed* and nothing
 * about what is *permitted*.
 */
async function grantedPermissions(
  supabase: CarlSupabaseClient,
  tenantId: string,
): Promise<ReadonlySet<Permission>> {
  const { data } = await supabase
    .from('role_permissions')
    .select('permission_key, roles!inner(tenant_id)')
    .eq('roles.tenant_id', tenantId)
    .returns<PermissionRow[]>();

  return new Set((data ?? []).map((row) => row.permission_key as Permission));
}

function toTenantStatus(value: string): TenantStatus {
  return value in TenantStatus ? (value as TenantStatus) : TenantStatus.SUSPENDED;
}
