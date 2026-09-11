import { NextResponse, type NextRequest } from 'next/server';

import { BRANCH_COOKIE, CONTEXT_COOKIE_OPTIONS, TENANT_COOKIE } from '@/lib/auth';
import { memberTenantAtSlug } from '@carl/infrastructure/auth/resolve-auth-context';
import { supabase } from '@/lib/supabase';

/**
 * Switches a signed-in member into the business named by the address.
 *
 * Reached only from `/[slug]` when the caller belongs to this business but their session is
 * operating in another one. A route handler rather than the page, because a page cannot set
 * cookies.
 *
 * The membership is re-checked here against the caller's own user id, never against what
 * RLS lets them read (the platform owner can read every business's memberships). A request
 * for a business the caller does not belong to switches nothing and returns them to its door.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const client = await supabase();

  const { data: userData } = await client.auth.getUser();
  if (!userData.user) return NextResponse.redirect(new URL(`/${slug}`, request.url));

  const membership = await memberTenantAtSlug(client, userData.user.id, slug);

  if (!membership) return NextResponse.redirect(new URL(`/${slug}`, request.url));

  const response = NextResponse.redirect(new URL('/dashboard', request.url));
  response.cookies.set(TENANT_COOKIE, membership.tenantId, CONTEXT_COOKIE_OPTIONS);
  // A branch chosen in the previous business means nothing in this one.
  response.cookies.delete(BRANCH_COOKIE);
  return response;
}
