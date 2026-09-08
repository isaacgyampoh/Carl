import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { requireAuth } from '@/lib/auth';

/**
 * The authenticated shell.
 *
 * Resolving the caller here rather than in each page means every route in this group is
 * behind a session by construction. It is not the security boundary — the database is —
 * but it removes a whole class of "forgot to check" mistakes from the page layer.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const auth = await requireAuth();
  return <AppShell auth={auth}>{children}</AppShell>;
}
