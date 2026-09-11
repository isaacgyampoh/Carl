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
 * ## Why every membership query filters by the caller's own user id
 *
 * RLS decides what may be READ, and reading is not the same as belonging. Migration 0028
 * lets the platform owner read every business's memberships, for the staff list on a
 * client's profile. A query that relied on RLS to mean "my memberships" therefore returned,
 * for the owner, every membership on the platform.
 *
 * That was the client-URL-opens-the-owner-console bug. The shop entry page asked "is this
 * person a member of this business?", found the business administrator's row, and let the
 * owner straight in; this resolver then gave the owner that business as their tenant, with
 * no permissions, inside a shell showing their owner console. So membership is always
 * `user_id = the verified caller`, never "whatever RLS lets me see".
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
  id: string;
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

interface RoleGrantRow {
  roles: {
    role_permissions: { permission_key: string }[] | null;
  } | null;
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
 * what the database says the user belongs to*, never grants. Asking for a tenant you are
 * not a member of never yields that tenant.
 */
export async function resolveAuthContext(
  supabase: CarlSupabaseClient,
  options: ResolveOptions = {},
): Promise<AuthContext | null> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return null;

  const authUser = userData.user;

  /*
   * Three questions about the same user id, asked at once.
   *
   * They used to be asked one after another, and every authenticated page in Carl waited for
   * all three before its own data was even requested — three round trips to the database
   * before the first row of a sales list. Nothing here depends on the answer to anything else
   * here, so the wait is one round trip, not three. The only cost is that the memberships are
   * read for a signed-in user who has no profile yet, which happens during provisioning and
   * nowhere else.
   */
  const [{ data: profile }, { data: platformAdmin }, { data: memberships }] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, email, full_name')
      .eq('id', authUser.id)
      .maybeSingle<{ id: string; email: string; full_name: string }>(),
    // Platform administration is read from its own table, never from a claim the client
    // could influence.
    supabase
      .from('platform_admins')
      .select('user_id')
      .eq('user_id', authUser.id)
      .maybeSingle<{ user_id: string }>(),
    supabase
      .from('tenant_memberships')
      .select('id, tenant_id, tenants(name, status)')
      .eq('user_id', authUser.id)
      .eq('status', 'ACTIVE')
      .order('created_at')
      .returns<MembershipRow[]>(),
  ]);

  // A user may be signed in without a Carl profile only during provisioning. Treat that as
  // no context rather than inventing one.
  if (!profile) return null;

  const user: AuthenticatedUser = {
    userId: asId<'UserId'>(profile.id),
    email: profile.email,
    fullName: profile.full_name,
    isPlatformAdmin: platformAdmin !== null,
  };

  const requestId = options.requestId ?? randomUuid();
  const tenant = await resolveTenant(supabase, memberships ?? [], options);

  return { user, tenant, deviceId: null, requestId };
}

/**
 * The business a signed-in person may enter at a shop's address, or null.
 *
 * Used by `/[slug]` and `/[slug]/enter`. Filtered by the caller's own user id for the reason
 * in this module's header: the platform owner can READ every business's memberships, and
 * must not thereby be treated as a member of every business.
 */
export async function memberTenantAtSlug(
  supabase: CarlSupabaseClient,
  userId: string,
  slug: string,
): Promise<{ tenantId: string } | null> {
  const { data } = await supabase
    .from('tenant_memberships')
    .select('tenant_id, tenants!inner(slug)')
    .eq('user_id', userId)
    .eq('tenants.slug', slug)
    .eq('status', 'ACTIVE')
    .limit(1)
    .maybeSingle<{ tenant_id: string }>();

  return data ? { tenantId: data.tenant_id } : null;
}

async function resolveTenant(
  supabase: CarlSupabaseClient,
  own: readonly MembershipRow[],
  options: ResolveOptions,
): Promise<TenantContext | null> {
  if (own.length === 0) return null;

  /*
   * Which of the caller's businesses this request operates in.
   *
   * The one the session chose, when it is one of theirs. Otherwise their business only when
   * they have exactly one, which is unambiguous. With several and no choice there is no
   * safe default: "the first one" is how a request ends up in the wrong business, so the
   * answer is no business until they enter one through its own address.
   */
  const requested = options.requestedTenantId
    ? own.find((m) => m.tenant_id === options.requestedTenantId)
    : undefined;
  const membership = requested ?? (own.length === 1 ? own[0] : undefined);

  if (!membership?.tenants) return null;

  const tenantId = asId<'TenantId'>(membership.tenant_id);

  const [branches, permissions] = await Promise.all([
    accessibleBranches(supabase, membership.tenant_id),
    grantedPermissions(supabase, membership.id),
  ]);

  // The requested branch is a filter over what the database already permits, never a
  // grant. Asking for a branch you cannot reach falls back to your first one.
  const requestedBranch = branches.find((branch) => branch.id === options.requestedBranchId);
  const activeBranchId = requestedBranch?.id ?? branches[0]?.id ?? null;

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
 * The permissions this user holds in this tenant: those of the roles on THEIR membership.
 *
 * The same rule `app.has_permission` enforces (membership → membership_roles →
 * role_permissions). It used to read every role_permissions row in the tenant, which RLS
 * lets any member read, so a cashier's context carried the owner's permissions: the full
 * navigation, a dashboard with reports, page guards that passed. The database still refused
 * the data, but what a cashier could open was decided by the wrong set.
 *
 * Used only to decide what the UI offers. The database checks permissions again on every
 * operation.
 */
async function grantedPermissions(
  supabase: CarlSupabaseClient,
  membershipId: string,
): Promise<ReadonlySet<Permission>> {
  const { data } = await supabase
    .from('membership_roles')
    .select('roles(role_permissions(permission_key))')
    .eq('membership_id', membershipId)
    .returns<RoleGrantRow[]>();

  return new Set(
    (data ?? [])
      .flatMap((row) => row.roles?.role_permissions ?? [])
      .map((grant) => grant.permission_key as Permission),
  );
}

function toTenantStatus(value: string): TenantStatus {
  return value in TenantStatus ? (value as TenantStatus) : TenantStatus.SUSPENDED;
}
