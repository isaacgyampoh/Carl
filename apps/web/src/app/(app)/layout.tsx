import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { currentAuth, requireAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

/**
 * What a browser may install from a business's screens: that business's Carl POS app.
 *
 * Without this, these screens inherited the root layout's manifest, whose start_url was `/`;
 * installing from the till produced an app that opened on the main website. The manifest is
 * the business's own when the session is in one, and otherwise the generic POS app, which
 * starts at /pos and finds the business's door from there.
 */
export async function generateMetadata(): Promise<Metadata> {
  const auth = await currentAuth();
  let manifest = '/manifest.webmanifest';
  if (auth?.tenant) {
    const client = await supabase();
    const { data } = await client
      .from('tenants')
      .select('slug')
      .eq('id', auth.tenant.tenantId)
      .maybeSingle();
    if (data?.slug) manifest = `/${data.slug}/manifest.webmanifest`;
  }
  return {
    manifest,
    applicationName: 'Carl POS',
    appleWebApp: { capable: true, title: 'Carl POS', statusBarStyle: 'default' },
  };
}

/**
 * The authenticated shell of a business: its portal and its till.
 *
 * Resolving the caller here rather than in each page means every route in this group is
 * behind a session by construction. It is not the security boundary — the database is —
 * but it removes a whole class of "forgot to check" mistakes from the page layer.
 *
 * The owner console is not in this group. It has its own, `(owner)`, with its own session.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const auth = await requireAuth();
  return <AppShell auth={auth}>{children}</AppShell>;
}
