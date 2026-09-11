import type { Metadata } from 'next';
import Link from 'next/link';
import { Permission } from '@carl/domain';
import { hasPermission } from '@carl/application';
import {
  Badge,
  Card,
  EmptyState,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  buttonClasses,
  statusTone,
} from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { ilikeAny, searchTerm } from '@/lib/search';
import { supabase } from '@/lib/supabase';
import { ListSearch } from '@/components/list-search';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { pageParams, toPage } from '@/server/queries';

export const metadata: Metadata = { title: 'Transfers' };
export const dynamic = 'force-dynamic';

interface TransferRow {
  id: string;
  reference: string;
  status: string;
  created_at: string;
  dispatched_at: string | null;
  received_at: string | null;
  from_branch: { name: string } | null;
  to_branch: { name: string } | null;
  stock_transfer_items: { id: string }[];
}

export default async function TransfersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const auth = await requirePermission(Permission.INVENTORY_VIEW);
  const params = await searchParams;
  const { page, pageSize, from, to } = pageParams(params);
  const search = searchTerm(params.q);

  const client = await supabase();
  let query = client
    .from('stock_transfers')
    .select(
      `id, reference, status, created_at, dispatched_at, received_at,
       from_branch:branches!stock_transfers_from_branch_id_fkey(name),
       to_branch:branches!stock_transfers_to_branch_id_fkey(name),
       stock_transfer_items(id)`,
      { count: 'exact' },
    )
    .eq('tenant_id', auth.tenant.tenantId)
    .order('created_at', { ascending: false })
    .range(from, to);
  if (search) query = query.or(ilikeAny(['reference'], search));
  const { data, count } = await query.returns<TransferRow[]>();

  const transfers = toPage(data, count, page, pageSize);

  return (
    <>
      <PageHeader
        title="Stock transfers"
        description="Stock leaves the sending branch when it is dispatched, not when it arrives — goods in a van belong to neither shelf."
        action={
          hasPermission(auth, Permission.INVENTORY_TRANSFER_CREATE) ? (
            <Link href="/transfers/new" className={buttonClasses()}>
              New transfer
            </Link>
          ) : null
        }
      />

      <div className="mb-4">
        <ListSearch
          initialQuery={search ?? ''}
          placeholder="Search by reference"
          label="Search transfers"
        />
      </div>

      <Card className="overflow-hidden">
        {transfers.rows.length === 0 ? (
          <EmptyState
            title={search ? `Nothing matches “${search}”` : 'No transfers yet'}
            description="Move stock between branches and every movement is recorded at both ends."
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Reference</TH>
                  <TH>From</TH>
                  <TH>To</TH>
                  <TH numeric>Lines</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {transfers.rows.map((transfer) => (
                  <TR key={transfer.id}>
                    <TD>
                      <Link
                        href={`/transfers/${transfer.id}`}
                        className="font-mono text-sm font-medium hover:text-[color:var(--color-brand)]"
                      >
                        {transfer.reference}
                      </Link>
                      <span className="block text-xs text-[color:var(--color-ink-muted)]">
                        {new Date(transfer.created_at).toLocaleDateString('en-GH')}
                      </span>
                    </TD>
                    <TD>{transfer.from_branch?.name ?? '—'}</TD>
                    <TD>{transfer.to_branch?.name ?? '—'}</TD>
                    <TD numeric>{transfer.stock_transfer_items.length}</TD>
                    <TD>
                      <Badge tone={statusTone(transfer.status)}>
                        {transfer.status.replace(/_/g, ' ').toLowerCase()}
                      </Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination
              page={transfers.page}
              pageCount={transfers.pageCount}
              total={transfers.total}
              basePath="/transfers"
              searchParams={params}
            />
          </>
        )}
      </Card>
    </>
  );
}
