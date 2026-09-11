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

/**
 * The owner console's second factor, as the Auth server sees it.
 *
 * A four-digit PIN at a public address is the whole barrier in front of a console that can
 * onboard, suspend and bill every customer on the platform. A second factor makes a stolen or
 * guessed PIN insufficient on its own.
 *
 * Read from Supabase Auth rather than from a table of our own: the assurance level is a claim
 * in the session the Auth server signs, so it cannot be set by anything the browser sends.
 */
export interface OwnerMfaState {
  /** A confirmed authenticator app exists on this account. */
  readonly enrolled: boolean;
  /** This session must reach the second factor before the console opens. */
  readonly required: boolean;
  /** It already has. */
  readonly satisfied: boolean;
  readonly factorId: string | null;
}

export async function ownerMfaState(): Promise<OwnerMfaState> {
  const client = await supabase();
  const [factors, levels] = await Promise.all([
    client.auth.mfa.listFactors(),
    client.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);
  const verified = factors.data?.totp?.find((factor) => factor.status === 'verified') ?? null;
  return {
    enrolled: verified !== null,
    // `nextLevel` is aal2 exactly when the account has a confirmed factor.
    required: levels.data?.nextLevel === 'aal2',
    satisfied: levels.data?.currentLevel === 'aal2',
    factorId: verified?.id ?? null,
  };
}

/**
 * The owner's session before the second factor.
 *
 * Only the entry page and the code check itself may use this: everything else must be behind
 * `requirePlatformAdmin`, which insists on the second factor once one is enrolled.
 */
export async function requireOwnerSession(): Promise<AuthContext> {
  const auth = await currentAuth();
  if (!auth?.user.isPlatformAdmin) redirect('/');
  return auth;
}

export async function requirePlatformAdmin(): Promise<AuthContext> {
  /*
   * The owner console's guard, on the owner console's own session (lib/surface.ts).
   *
   * Signed out, or signed in only to a business on this device, the answer is the owner's PIN
   * at the main address — never the merchant sign-in page, which asks for an email and
   * password the platform owner does not use, and never a business screen.
   *
   * A session that has not passed the second factor is turned back to the same place, where
   * the entry page asks for the code. The PIN alone never opens the console.
   */
  const auth = await currentAuth();
  if (!auth?.user.isPlatformAdmin) redirect('/');

  const mfa = await ownerMfaState();
  if (mfa.required && !mfa.satisfied) redirect('/');

  return auth;
}
