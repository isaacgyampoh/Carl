import type { Metadata } from 'next';
import { Permission } from '@carl/domain';
import { activeBranch, hasPermission } from '@carl/application';
import { formatMoney } from '@carl/shared';
import { Badge, Card, CardHeader, EmptyState, Table, TBody, TD, TH, THead, TR } from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';
import { RegisterPanel } from './register-panel';

export const metadata: Metadata = { title: 'Cash register' };
export const dynamic = 'force-dynamic';

interface SessionRow {
  id: string;
  status: string;
  opening_float: number;
  cash_sales: number;
  cash_refunds: number;
  cash_in: number;
  cash_out: number;
  cash_expenses: number;
  expected_cash: number | null;
  counted_cash: number | null;
  variance: number | null;
  variance_note: string | null;
  opened_at: string;
  closed_at: string | null;
  cash_registers: { name: string } | null;
  profiles: { full_name: string } | null;
}

export default async function RegisterPage() {
  const auth = await requirePermission(Permission.REGISTER_OPEN);
  const branch = activeBranch(auth);

  // A drawer belongs to a branch. Without this, a manager of two branches saw the other
  // branch's registers, and its open session presented as this one's.
  const branchFilter = branch ? { branch_id: branch.id } : {};

  const client = await supabase();
  const [{ data: registers }, { data: sessions }] = await Promise.all([
    client
      .from('cash_registers')
      .select('id, name')
      .eq('tenant_id', auth.tenant.tenantId)
      .match(branchFilter)
      .eq('is_active', true)
      .order('name')
      .returns<{ id: string; name: string }[]>(),
    client
      .from('cash_sessions')
      .select(
        `id, status, opening_float, cash_sales, cash_refunds, cash_in, cash_out, cash_expenses,
         expected_cash, counted_cash, variance, variance_note, opened_at, closed_at,
         cash_registers(name), profiles!cash_sessions_opened_by_fkey(full_name)`,
      )
      .eq('tenant_id', auth.tenant.tenantId)
      .match(branchFilter)
      .order('opened_at', { ascending: false })
      .limit(20)
      .returns<SessionRow[]>(),
  ]);

  const open = (sessions ?? []).find((session) => session.status === 'OPEN');
  const closed = (sessions ?? []).filter((session) => session.status !== 'OPEN');

  return (
    <>
      <PageHeader
        title="Cash register"
        description={
          branch
            ? `Drawer sessions at ${branch.name}. What should be in the till, against what was counted.`
            : 'Drawer sessions.'
        }
      />

      <div className="grid gap-5 lg:grid-cols-[22rem_1fr]">
        <RegisterPanel
          registers={registers ?? []}
          openSession={
            open
              ? {
                  id: open.id,
                  registerName: open.cash_registers?.name ?? 'Register',
                  openedAt: open.opened_at,
                  openingFloat: open.opening_float,
                  // Shown so the cashier can compare against the drawer before counting.
                  expected:
                    open.opening_float +
                    open.cash_sales -
                    open.cash_refunds +
                    open.cash_in -
                    open.cash_out -
                    open.cash_expenses,
                }
              : null
          }
          canClose={hasPermission(auth, Permission.REGISTER_CLOSE)}
          canMoveCash={hasPermission(auth, Permission.REGISTER_CASH_MOVEMENT)}
        />

        <Card className="overflow-hidden">
          <CardHeader
            title="Recent sessions"
            description="A variance is stored as it was found, not recomputed later."
          />
          {closed.length === 0 ? (
            <EmptyState
              title="No closed sessions yet"
              description="Sessions appear here once a drawer has been counted and closed."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Register</TH>
                  <TH>Opened by</TH>
                  <TH numeric>Expected</TH>
                  <TH numeric>Counted</TH>
                  <TH numeric>Variance</TH>
                </TR>
              </THead>
              <TBody>
                {closed.map((session) => (
                  <TR key={session.id}>
                    <TD>
                      <span className="font-medium">{session.cash_registers?.name}</span>
                      <span className="block text-xs text-[color:var(--color-ink-muted)]">
                        {new Date(session.opened_at).toLocaleDateString('en-GH')}
                      </span>
                    </TD>
                    <TD className="text-[color:var(--color-ink-muted)]">
                      {session.profiles?.full_name ?? '—'}
                    </TD>
                    <TD numeric>{formatMoney(session.expected_cash ?? 0)}</TD>
                    <TD numeric>{formatMoney(session.counted_cash ?? 0)}</TD>
                    <TD numeric>
                      {session.variance === 0 || session.variance === null ? (
                        <Badge tone="positive">Balanced</Badge>
                      ) : (
                        <span
                          className={
                            session.variance < 0
                              ? 'text-[color:var(--color-danger)]'
                              : 'text-[color:var(--color-warning)]'
                          }
                          title={session.variance_note ?? undefined}
                        >
                          {session.variance > 0 ? '+' : ''}
                          {formatMoney(session.variance)}
                        </span>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
