import 'server-only';

import { cache } from 'react';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
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
  const requestHeaders = await headers();
  return resolveAuthContext(client, {
    requestId: requestHeaders.get('x-request-id') ?? undefined,
  });
});

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
  const auth = await requireAuth();
  if (!auth.user.isPlatformAdmin) redirect('/no-access');
  return auth;
}
