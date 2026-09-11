import 'server-only';

import { cookies, headers } from 'next/headers';
import {
  serverClient,
  serviceRoleClient,
  type CarlSupabaseClient,
} from '@carl/infrastructure/supabase/server-client';

import { OWNER_SESSION_COOKIE, SURFACE_HEADER, surfaceFromHeader, type Surface } from './surface';

/**
 * The Supabase client for the current request, acting as the signed-in user.
 *
 * This is the default for everything. Its queries are filtered by Row Level Security
 * exactly as a browser's would be, which is what makes a forgotten permission check in a
 * server action harmless rather than a data leak.
 *
 * It reads the session of the application the request belongs to: the owner console's own
 * cookie on the owner's pages, a business's everywhere else. The proxy decides which, from the
 * path (lib/surface.ts), so a till's sign-in can never stand in for the owner's or replace it.
 */
export async function supabase(): Promise<CarlSupabaseClient> {
  const [store, surface] = await Promise.all([cookies(), currentSurface()]);
  return serverClient(
    {
      getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
      set: (name, value, options) => {
        store.set(name, value, options);
      },
    },
    surface === 'owner' ? { name: OWNER_SESSION_COOKIE } : {},
  );
}

/** The application this request belongs to, as the proxy determined it. */
export async function currentSurface(): Promise<Surface> {
  return surfaceFromHeader((await headers()).get(SURFACE_HEADER));
}

/**
 * A client that bypasses Row Level Security.
 *
 * Only for operations that genuinely cannot run as a user because no authorised user
 * exists yet — provisioning a tenant, activating a device. Every call site should be able
 * to say which of those it is.
 */
export { serviceRoleClient };
export type { CarlSupabaseClient };
