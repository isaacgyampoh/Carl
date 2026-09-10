import type { Metadata } from 'next';
import { Badge, Card, CardHeader, EmptyState } from '@carl/ui';
import { Currency, formatMoney } from '@carl/shared';

import { PageHeader } from '@/components/page-header';
import { requirePlatformAdmin } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

export const metadata: Metadata = { title: 'Settings · Carl platform' };
export const dynamic = 'force-dynamic';

/**
 * Platform settings.
 *
 * Read-only on purpose, for now.
 *
 * The plans a customer can be put on, and who may operate the platform, are both things
 * that change rarely and matter enormously when they change. Editing them through a
 * console would need its own audited operations — a plan price edited by accident silently
 * changes what every future customer is billed, and a platform administrator added by
 * accident is a full compromise. Neither is worth a convenience button, so this shows the
 * current state and the change goes through a migration.
 */
export default async function SettingsPage() {
  await requirePlatformAdmin();
  const client = await supabase();

  const [plans, admins] = await Promise.all([
    client
      .from('subscription_plans')
      .select(
        'id, key, name, description, price, currency_code, interval, max_branches, max_devices, max_users, is_active',
      )
      .order('sort_order'),
    client
      .from('platform_admins')
      .select('user_id, granted_at, note, profiles(full_name, email)')
      .order('granted_at'),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title="Settings" description="Plans and platform access." />

      <Card>
        <CardHeader
          title="Subscription plans"
          description="What a client can be put on. Changed by migration, not here."
        />
        {plans.data?.length ? (
          <ul className="divide-y divide-[color:var(--color-border)]">
            {plans.data.map((p) => (
              <li key={p.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{p.name}</span>
                      {!p.is_active && <Badge tone="neutral">Inactive</Badge>}
                    </div>
                    {p.description && (
                      <p className="text-sm text-[color:var(--color-text-muted)]">
                        {p.description}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="tabular-nums">
                      {formatMoney(p.price, (p.currency_code as Currency) ?? Currency.GHS)}
                    </div>
                    <div className="text-sm text-[color:var(--color-text-muted)]">
                      {p.interval.toLowerCase()}
                    </div>
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-sm text-[color:var(--color-text-muted)]">
                  <span>
                    {p.max_branches ? `${p.max_branches} branches` : 'Unlimited branches'}
                  </span>
                  <span>
                    {p.max_devices ? `${p.max_devices} terminals` : 'Unlimited terminals'}
                  </span>
                  <span>{p.max_users ? `${p.max_users} users` : 'Unlimited users'}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No plans" description="A client cannot be onboarded without one." />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Platform administrators"
          description="Full access to every customer account. Granted by migration."
        />
        {admins.data?.length ? (
          <ul className="divide-y divide-[color:var(--color-border)]">
            {admins.data.map((a) => {
              const profile = a.profiles as { full_name?: string; email?: string } | null;
              return (
                <li key={a.user_id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{profile?.full_name ?? '—'}</span>
                    <span className="block truncate text-sm text-[color:var(--color-text-muted)]">
                      {profile?.email ?? a.user_id}
                    </span>
                  </span>
                  <time
                    dateTime={a.granted_at}
                    className="shrink-0 text-sm text-[color:var(--color-text-muted)]"
                  >
                    {new Date(a.granted_at).toLocaleDateString('en-GB')}
                  </time>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState title="No platform administrators" />
        )}
      </Card>

      <Card>
        <CardHeader title="What a platform administrator cannot do" />
        <div className="space-y-2 p-4 text-sm text-[color:var(--color-text-muted)]">
          <p>
            Platform access covers the commercial relationship — clients, branches, terminals,
            subscriptions, billing and platform activity. It does not include any customer&apos;s
            own trade.
          </p>
          <p>
            Reading a merchant&apos;s sales, stock, customers or takings requires an explicit,
            time-boxed support grant that the customer can see and revoke. That boundary is enforced
            by row-level security in the database, not by these screens.
          </p>
        </div>
      </Card>
    </div>
  );
}
