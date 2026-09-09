import type { Metadata } from 'next';
import { Permission } from '@carl/domain';
import { hasPermission } from '@carl/application';
import { formatMoney } from '@carl/shared';
import { Badge, Card, EmptyState, Table, TBody, TD, TH, THead, TR, statusTone } from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { pageParams, toPage } from '@/server/queries';
import { ExpenseApproval } from './expense-approval';

export const metadata: Metadata = { title: 'Expenses' };
export const dynamic = 'force-dynamic';

interface ExpenseRow {
  id: string;
  reference: string;
  description: string;
  amount: number;
  method: string;
  status: string;
  expense_date: string;
  expense_categories: { name: string } | null;
  profiles: { full_name: string } | null;
}

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const auth = await requirePermission(Permission.EXPENSES_VIEW);
  const params = await searchParams;
  const { page, pageSize, from, to } = pageParams(params);
  const canApprove = hasPermission(auth, Permission.EXPENSES_APPROVE);

  const client = await supabase();
  const { data, count } = await client
    .from('expenses')
    .select(
      `id, reference, description, amount, method, status, expense_date,
       expense_categories(name), profiles!expenses_created_by_fkey(full_name)`,
      { count: 'exact' },
    )
    .order('expense_date', { ascending: false })
    .range(from, to)
    .returns<ExpenseRow[]>();

  const expenses = toPage(data, count, page, pageSize);
  const pending = expenses.rows.filter((row) => row.status === 'PENDING_APPROVAL');

  return (
    <>
      <PageHeader
        title="Expenses"
        description="Money out. Recording and approving are separate permissions on purpose."
      />

      {canApprove && pending.length > 0 && (
        <div className="mb-4">
          <ExpenseApproval count={pending.length} />
        </div>
      )}

      <Card className="overflow-hidden">
        {expenses.rows.length === 0 ? (
          <EmptyState
            title="No expenses recorded"
            description="Expenses recorded at a branch appear here and affect the cash reconciliation."
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Reference</TH>
                  <TH>Description</TH>
                  <TH>Category</TH>
                  <TH>Recorded by</TH>
                  <TH numeric>Amount</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {expenses.rows.map((expense) => (
                  <TR key={expense.id}>
                    <TD className="font-mono text-xs">{expense.reference}</TD>
                    <TD>
                      <span className="font-medium">{expense.description}</span>
                      <span className="block text-xs text-[color:var(--color-ink-muted)]">
                        {new Date(expense.expense_date).toLocaleDateString('en-GH')} ·{' '}
                        {expense.method.replace(/_/g, ' ').toLowerCase()}
                      </span>
                    </TD>
                    <TD className="text-[color:var(--color-ink-muted)]">
                      {expense.expense_categories?.name ?? '—'}
                    </TD>
                    <TD className="text-[color:var(--color-ink-muted)]">
                      {expense.profiles?.full_name ?? '—'}
                    </TD>
                    <TD numeric>{formatMoney(expense.amount)}</TD>
                    <TD>
                      <Badge tone={statusTone(expense.status)}>
                        {expense.status.replace(/_/g, ' ').toLowerCase()}
                      </Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination
              page={expenses.page}
              pageCount={expenses.pageCount}
              total={expenses.total}
              basePath="/expenses"
              searchParams={params}
            />
          </>
        )}
      </Card>
    </>
  );
}
