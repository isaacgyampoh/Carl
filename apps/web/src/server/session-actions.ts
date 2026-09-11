'use server';

import { cookies } from 'next/headers';

import { BRANCH_COOKIE, TENANT_COOKIE, currentAuth } from '@/lib/auth';
import { currentSurface, supabase } from '@/lib/supabase';
import { actionOk, type ActionResult } from './errors';

/**
 * Ends the session and says where the person should go next.
 *
 * Sign-out used to happen in the browser and send everyone to `/sign-in` — the email and
 * password page that people who sign in with a PIN cannot use. A cashier ending a shift was
 * left on a screen with no way back in. It also could not clear the tenant and branch
 * cookies, which are httpOnly precisely so the browser cannot forge them.
 *
 * It ends the session of the application it was pressed in, and only that one
 * (lib/surface.ts). The owner signing out of the console leaves a till on the same device
 * signed in, and a cashier ending a shift does not sign the owner out.
 *
 * The owner returns to the PIN at the main address. Staff return to their own business's
 * door: the till's, when they were at the till (`till` is where they were, not who they are).
 */
export async function signOut(
  input: { till?: boolean } = {},
): Promise<ActionResult<{ next: string }>> {
  const [auth, surface] = await Promise.all([currentAuth(), currentSurface()]);
  const client = await supabase();

  if (surface === 'owner') {
    await client.auth.signOut();
    return actionOk({ next: '/' });
  }

  let next = '/sign-in';
  if (auth?.tenant) {
    const { data } = await client
      .from('tenants')
      .select('slug')
      .eq('id', auth.tenant.tenantId)
      .maybeSingle();
    if (data?.slug) next = input.till === true ? `/${data.slug}/pos` : `/${data.slug}`;
  }

  await client.auth.signOut();
  const store = await cookies();
  store.delete(TENANT_COOKIE);
  store.delete(BRANCH_COOKIE);

  return actionOk({ next });
}
