/**
 * The authenticated caller.
 *
 * ## What this is not
 *
 * It is not a source of authority. Every value here is *derived server-side* from a verified
 * session and the database's own membership records — never read from a request body, a
 * header, a hidden form field or a URL parameter. Nothing a client sends can change a single
 * field of it.
 *
 * That distinction is the whole of Carl's tenant isolation. A caller who edits `tenant_id` in
 * a request changes nothing, because this context — and the RLS policies underneath it —
 * never consulted the request in the first place.
 *
 * ## Why it exists at all, if the database enforces everything
 *
 * RLS is the guarantee, but a use case still needs to know who it is acting for in order to
 * choose a branch, pick a price tier, or write an audit entry. This is that, and it is
 * deliberately a read-only snapshot.
 */

import type { BranchId, TenantId, UserId } from '@carl/shared';
import type { Permission } from '@carl/domain';

export interface AuthenticatedUser {
  readonly userId: UserId;
  readonly email: string;
  readonly fullName: string;
  /**
   * Whether this account administers the Carl platform itself.
   *
   * Platform administration is deliberately NOT a super-permission over tenant data. A
   * platform admin manages tenants, subscriptions, devices and support records; reading a
   * customer's sales requires a separate, audited support-access grant.
   */
  readonly isPlatformAdmin: boolean;
}

/**
 * A branch the caller may act in.
 *
 * Carries the name and code, not just the id: every screen that offers a branch choice
 * needs to display one, and resolving names separately would mean a second round trip on
 * every page render just to label a dropdown.
 */
export interface AccessibleBranch {
  readonly id: BranchId;
  readonly code: string;
  readonly name: string;
}

export interface TenantContext {
  readonly tenantId: TenantId;
  readonly tenantName: string;
  readonly status: TenantStatus;
  /** Branches this user may act in, as determined by the database — never by the request. */
  readonly branches: readonly AccessibleBranch[];
  /** The branch the current session is operating in, when one has been selected. */
  readonly activeBranchId: BranchId | null;
  readonly permissions: ReadonlySet<Permission>;
}

export const TenantStatus = {
  TRIAL: 'TRIAL',
  ACTIVE: 'ACTIVE',
  GRACE_PERIOD: 'GRACE_PERIOD',
  SUSPENDED: 'SUSPENDED',
  CANCELLED: 'CANCELLED',
} as const;

export type TenantStatus = (typeof TenantStatus)[keyof typeof TenantStatus];

/** Statuses under which a tenant may still transact. */
export const OPERABLE_TENANT_STATUSES: readonly TenantStatus[] = [
  TenantStatus.TRIAL,
  TenantStatus.ACTIVE,
  TenantStatus.GRACE_PERIOD,
];

export function canTransact(status: TenantStatus): boolean {
  return OPERABLE_TENANT_STATUSES.includes(status);
}

export interface AuthContext {
  readonly user: AuthenticatedUser;
  readonly tenant: TenantContext | null;
  /** Set when the request originated from a registered POS terminal. */
  readonly deviceId: string | null;
  /** Correlates every log line and audit entry for one request. */
  readonly requestId: string;
}

/** Reads a permission from the context. Convenience only — the database still decides. */
export function hasPermission(context: AuthContext, permission: Permission): boolean {
  return context.tenant?.permissions.has(permission) ?? false;
}

export function hasAnyPermission(
  context: AuthContext,
  permissions: readonly Permission[],
): boolean {
  return permissions.some((permission) => hasPermission(context, permission));
}

/** Whether the caller may act in a given branch. */
export function canAccessBranch(context: AuthContext, branchId: BranchId): boolean {
  return context.tenant?.branches.some((branch) => branch.id === branchId) ?? false;
}

/** The branch the session is operating in, resolved to its full record. */
export function activeBranch(context: AuthContext): AccessibleBranch | null {
  const tenant = context.tenant;
  if (!tenant?.activeBranchId) return null;
  return tenant.branches.find((branch) => branch.id === tenant.activeBranchId) ?? null;
}
