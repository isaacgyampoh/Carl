'use server';

import { cookies } from 'next/headers';

import { BRANCH_COOKIE, TENANT_COOKIE, currentAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { actionOk, type ActionResult } from './errors';

/**
 * Ends the session and says where the person should go next.
 *
 * Sign-out used to happen in the browser and send everyone to `/sign-in` — the email and
 * password page that people who sign in with a PIN cannot use. A cashier ending a shift was
 * left on a screen with no way back in. It also could not clear the tenant and branch
 * cookies, which are httpOnly precisely so the browser cannot forge them.
 *
 * Staff return to their own business's address, and the platform owner to the owner PIN
 * prompt.
 */
export async function signOut(): Promise<ActionResult<{ next: string }>> {
  const auth = await currentAuth();
  const client = await supabase();

  let next = '/sign-in';
  if (auth?.tenant) {
    const { data } = await client
      .from('tenants')
      .select('slug')
      .eq('id', auth.tenant.tenantId)
      .maybeSingle();
    if (data?.slug) next = `/${data.slug}`;
  } else if (auth?.user.isPlatformAdmin) {
    next = '/platform/sign-in';
  }

  await client.auth.signOut();
  const store = await cookies();
  store.delete(TENANT_COOKIE);
  store.delete(BRANCH_COOKIE);

  return actionOk({ next });
}
