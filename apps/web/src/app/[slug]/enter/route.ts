import { NextResponse, type NextRequest } from 'next/server';

import { BRANCH_COOKIE, CONTEXT_COOKIE_OPTIONS, TENANT_COOKIE } from '@/lib/auth';
import { businessDestination, entryFrom } from '@/lib/destinations';
import {
  memberTenantAtSlug,
  resolveAuthContext,
} from '@carl/infrastructure/auth/resolve-auth-context';
import { supabase } from '@/lib/supabase';

/**
 * Enters the business named by the address, and goes where this person works in it.
 *
 * Reached after a PIN at `/{slug}` or `/{slug}/pos`, and from either door when the caller is
 * already signed in. A route handler rather than a page, because a page cannot set cookies.
 *
 * The membership is re-checked here against the caller's own user id, never against what RLS
 * lets them read (the platform owner can read every business's memberships). A request for a
 * business the caller does not belong to switches nothing and returns them to its door.
 *
 * The destination comes from the person's own grants in THIS business, resolved from the
 * verified session (lib/destinations.ts): the till app's door (`?to=pos`) always leads to the
 * till, the business's address to the dashboard or, for a cashier, the till.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const entry = entryFrom(request.nextUrl.searchParams.get('to'));
  const door = new URL(entry === 'pos' ? `/${slug}/pos` : `/${slug}`, request.url);
  const client = await supabase();

  const { data: userData } = await client.auth.getUser();
  if (!userData.user) return NextResponse.redirect(door);

  const membership = await memberTenantAtSlug(client, userData.user.id, slug);

  if (!membership) return NextResponse.redirect(door);

  const context = await resolveAuthContext(client, { requestedTenantId: membership.tenantId });
  const response = NextResponse.redirect(new URL(businessDestination(context, entry), request.url));
  response.cookies.set(TENANT_COOKIE, membership.tenantId, CONTEXT_COOKIE_OPTIONS);
  // A branch chosen in the previous business means nothing in this one.
  response.cookies.delete(BRANCH_COOKIE);
  return response;
}
