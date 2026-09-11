import 'server-only';

import { cache } from 'react';
import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import type { AuthContext } from '@carl/application';
import { hasPermission } from '@carl/application';
import type { Permission } from '@carl/domain';
import { resolveAuthContext } from '@carl/infrastructure/auth/resolve-auth-context';

import { supabase } from './supabase';

/**
 * The current caller.
 *
 * Wrapped in React's `cache` so a page and its several server components resolve the
 * context once per request rather than issuing the same membership queries five times.
 */
export const currentAuth = cache(async (): Promise<AuthContext | null> => {
  const client = await supabase();
  const [requestHeaders, store] = await Promise.all([headers(), cookies()]);

  /*
   * The tenant and branch this session chose, read from cookies set by the server when the
   * person signed in at a business's address or picked a branch.
   *
   * They are FILTERS, never grants: `resolveAuthContext` matches them against the
   * memberships and branches RLS already lets this user read, so a forged cookie naming
   * another business selects nothing. Before this, nothing tied a session to the address it
   * signed in at — every request fell back to the user's first membership and first branch,
   * which is why the branch switcher did nothing on the server.
   */
  return resolveAuthContext(client, {
    requestId: requestHeaders.get('x-request-id') ?? undefined,
    requestedTenantId: uuidOrUndefined(store.get(TENANT_COOKIE)?.value),
    requestedBranchId: uuidOrUndefined(store.get(BRANCH_COOKIE)?.value),
  });
});

/** Cookie naming the business a session is operating in. Set only by the server. */
export const TENANT_COOKIE = 'carl_tenant';
/** Cookie naming the branch a session is operating in. Set only by the server. */
export const BRANCH_COOKIE = 'carl_branch';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidOrUndefined(value: string | undefined): string | undefined {
  return value && UUID.test(value) ? value : undefined;
}

/** How long a chosen business or branch is remembered on this device. */
export const CONTEXT_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 60 * 60 * 24 * 30,
};

/** The current caller, redirecting to sign-in when there is none. */
export async function requireAuth(): Promise<AuthContext> {
  const auth = await currentAuth();
  if (!auth) redirect('/sign-in');
  return auth;
}

/**
 * The current caller with an active tenant.
 *
 * A signed-in user with no tenant membership is a real state — an account provisioned but
 * not yet attached to a business — and it needs its own screen rather than an error.
 */
export type TenantAuthContext = AuthContext & { tenant: NonNullable<AuthContext['tenant']> };

export async function requireTenant(): Promise<TenantAuthContext> {
  const auth = await requireAuth();
  if (!auth.tenant) redirect('/no-access');
  return auth as TenantAuthContext;
}

/**
 * Requires a permission before rendering.
 *
 * A convenience for keeping unusable pages out of reach, **not** the enforcement. The
 * database checks the same permission on every query and refuses regardless of what
 * happens here — which is why forgetting this call leaks nothing.
 */
export async function requirePermission(permission: Permission): Promise<TenantAuthContext> {
  const auth = await requireTenant();
  if (!hasPermission(auth, permission)) redirect('/no-access');
  return auth;
}

export async function requirePlatformAdmin(): Promise<AuthContext> {
  /*
   * Unauthenticated callers go to the owner's PIN prompt, not the merchant sign-in page.
   * The platform owner has no email-and-password credential to offer there, so sending
   * them to it is a dead end.
   *
   * A signed-in user who is not a platform administrator still gets /no-access: they have
   * a working identity, it simply does not include this.
   */
  const auth = await currentAuth();
  if (!auth) redirect('/platform/sign-in');
  if (!auth.user.isPlatformAdmin) redirect('/no-access');
  return auth;
}
