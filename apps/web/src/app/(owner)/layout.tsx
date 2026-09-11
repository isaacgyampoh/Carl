import type { ReactNode } from 'react';

import { OwnerShell } from '@/components/app-shell';
import { requirePlatformAdmin } from '@/lib/auth';

/**
 * The owner console.
 *
 * Its own route group and its own shell, not the business application's with extra links. It
 * used to live inside `(app)`: with a business in the session the owner saw the till's
 * navigation around the console, and the shell's home link led to the business dashboard.
 *
 * Guarded as a whole, on the owner console's own session (lib/surface.ts). Signed out, or
 * signed in only to a business on this device, every console screen returns to the owner's
 * PIN at the main address.
 */
export default async function OwnerLayout({ children }: { children: ReactNode }) {
  const auth = await requirePlatformAdmin();
  return <OwnerShell auth={auth}>{children}</OwnerShell>;
}
