import type { Metadata } from 'next';
import { formatMoney } from '@carl/shared';
import { Badge, Card, EmptyState, Table, TBody, TD, TH, THead, TR, statusTone } from '@carl/ui';

import { requirePlatformAdmin } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { pageParams, toPage } from '@/server/queries';

export const metadata: Metadata = { title: 'Businesses' };
export const dynamic = 'force-dynamic';

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  currency_code: string;
  created_at: string;
  trial_ends_at: string | null;
  suspension_reason: string | null;
  branches: { id: string }[];
  subscriptions: { status: string; price: number; current_period_end: string }[];
}

export default async function PlatformTenantsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePlatformAdmin();
  const params = await searchParams;
  const { page, pageSize, from, to } = pageParams(params);

  const client = await supabase();
  const { data, count } = await client
    .from('tenants')
    .select(
      `id, name, slug, status, currency_code, created_at, trial_ends_at, suspension_reason,
       branches(id),
       subscriptions(status, price, current_period_end)`,
      { count: 'exact' },
    )
    .order('created_at', { ascending: false })
    .range(from, to)
    .returns<TenantRow[]>();

  const tenants = toPage(data, count, page, pageSize);

  return (
    <>
      <PageHeader
        title="Businesses"
        description="Every business running on Carl. Their trading data is not visible from here."
      />

      <Card className="overflow-hidden">
        {tenants.rows.length === 0 ? (
          <EmptyState
            title="No businesses yet"
            description="A business is provisioned with an owner account, a first branch and its system roles, all in one transaction."
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Business</TH>
                  <TH numeric>Branches</TH>
                  <TH>Subscription</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {tenants.rows.map((tenant) => {
                  const subscription = tenant.subscriptions[0];
                  return (
                    <TR key={tenant.id}>
                      <TD>
                        <span className="font-medium">{tenant.name}</span>
                        <span className="block font-mono text-xs text-[color:var(--color-ink-muted)]">
                          {tenant.slug} · since{' '}
                          {new Date(tenant.created_at).toLocaleDateString('en-GH')}
                        </span>
                      </TD>
                      <TD numeric>{tenant.branches.length}</TD>
                      <TD className="text-[color:var(--color-ink-muted)]">
                        {subscription ? (
                          <>
                            {formatMoney(subscription.price)}
                            <span className="block text-xs">
                              renews{' '}
                              {new Date(subscription.current_period_end).toLocaleDateString(
                                'en-GH',
                              )}
                            </span>
                          </>
                        ) : tenant.trial_ends_at ? (
                          <span className="text-xs">
                            trial ends {new Date(tenant.trial_ends_at).toLocaleDateString('en-GH')}
                          </span>
                        ) : (
                          '—'
                        )}
                      </TD>
                      <TD>
                        <Badge tone={statusTone(tenant.status)}>
                          {tenant.status.replace(/_/g, ' ').toLowerCase()}
                        </Badge>
                        {tenant.suspension_reason && (
                          <span className="block text-xs text-[color:var(--color-ink-muted)]">
                            {tenant.suspension_reason}
                          </span>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
            <Pagination
              page={tenants.page}
              pageCount={tenants.pageCount}
              total={tenants.total}
              basePath="/platform/tenants"
              searchParams={params}
            />
          </>
        )}
      </Card>
    </>
  );
}
