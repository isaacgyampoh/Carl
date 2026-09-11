import type { Metadata } from 'next';
import { hasPermission } from '@carl/application';
import { Permission } from '@carl/domain';
import { Badge, Card, EmptyState, Table, TBody, TD, TH, THead, TR, statusTone } from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';
import { AddStaffForm, type RoleOption } from './add-staff-form';
import { StaffRowActions } from './staff-row-actions';

export const metadata: Metadata = { title: 'Staff' };
export const dynamic = 'force-dynamic';

interface MembershipRow {
  id: string;
  user_id: string;
  status: string;
  is_owner: boolean;
  job_title: string | null;
  profiles: { full_name: string } | null;
  membership_roles: { roles: { name: string; key: string; rank: number } | null }[];
  membership_branches: { branch_id: string; branches: { name: string } | null }[];
}

interface RoleRow {
  key: string;
  name: string;
  rank: number;
}

/**
 * The people who work for this business, and what each may do.
 *
 * Every figure and every control on this page is also enforced by the database: RLS decides
 * who appears, and the staff functions refuse any change the viewer is not entitled to make.
 * What is hidden here is hidden for clarity, not for security.
 */
export default async function StaffPage() {
  const auth = await requirePermission(Permission.STAFF_VIEW);
  const canManage =
    hasPermission(auth, Permission.STAFF_MANAGE) && hasPermission(auth, Permission.ROLES_MANAGE);

  const client = await supabase();
  const [staffResult, rolesResult] = await Promise.all([
    client
      .from('tenant_memberships')
      .select(
        `id, user_id, status, is_owner, job_title,
         profiles(full_name),
         membership_roles(roles(name, key, rank)),
         membership_branches(branch_id, branches(name))`,
      )
      .eq('tenant_id', auth.tenant.tenantId)
      .neq('status', 'REMOVED')
      .order('created_at')
      .returns<MembershipRow[]>(),
    client
      .from('roles')
      .select('key, name, rank')
      .eq('tenant_id', auth.tenant.tenantId)
      .order('rank')
      .returns<RoleRow[]>(),
  ]);

  const staff = staffResult.data ?? [];
  const me = staff.find((m) => m.user_id === auth.user.userId);

  // The strongest role the viewer holds. Nobody may grant, or change someone into, more.
  const myRank = Math.min(
    ...(me?.membership_roles.map((r) => r.roles?.rank ?? Number.MAX_SAFE_INTEGER) ?? []),
    Number.MAX_SAFE_INTEGER,
  );
  const grantable: RoleOption[] = (rolesResult.data ?? [])
    .filter((role) => role.key !== 'tenant_owner' && role.rank >= myRank)
    .map((role) => ({ key: role.key, name: role.name }));

  const strongest = (m: MembershipRow) =>
    Math.min(
      ...m.membership_roles.map((r) => r.roles?.rank ?? Number.MAX_SAFE_INTEGER),
      Number.MAX_SAFE_INTEGER,
    );

  return (
    <>
      <PageHeader
        title="Staff"
        description="Who works here and what they may do. Each person signs in at your business's address with their own PIN."
        action={
          canManage ? (
            <AddStaffForm
              roles={grantable}
              branches={auth.tenant.branches.map((b) => ({ id: b.id, name: b.name }))}
            />
          ) : undefined
        }
      />

      <Card className="overflow-hidden">
        {staff.length === 0 ? (
          <EmptyState title="No staff yet" description="Add a cashier to start selling." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Person</TH>
                <TH>Role</TH>
                <TH>Branches</TH>
                <TH>Status</TH>
                {canManage && <TH className="text-right">Manage</TH>}
              </TR>
            </THead>
            <TBody>
              {staff.map((member) => {
                const manageable =
                  canManage &&
                  !member.is_owner &&
                  member.user_id !== auth.user.userId &&
                  strongest(member) >= myRank;
                return (
                  <TR key={member.id}>
                    <TD>
                      <span className="font-medium">{member.profiles?.full_name}</span>
                      {member.job_title && (
                        <span className="block text-xs text-[color:var(--color-ink-muted)]">
                          {member.job_title}
                        </span>
                      )}
                    </TD>
                    <TD>
                      <div className="flex flex-wrap gap-1.5">
                        {member.is_owner && <Badge tone="brand">Owner</Badge>}
                        {member.membership_roles.length === 0 && !member.is_owner ? (
                          <span className="text-xs text-[color:var(--color-warning)]">
                            No role — cannot see anything
                          </span>
                        ) : (
                          member.membership_roles
                            .filter((r) => r.roles?.key !== 'tenant_owner')
                            .map((r, i) => (
                              <Badge key={i} tone="neutral">
                                {r.roles?.name}
                              </Badge>
                            ))
                        )}
                      </div>
                    </TD>
                    <TD className="text-[color:var(--color-ink-muted)]">
                      {member.membership_branches.length === 0 ? (
                        <span className="text-xs">Every branch</span>
                      ) : (
                        member.membership_branches
                          .map((b) => b.branches?.name)
                          .filter(Boolean)
                          .join(', ')
                      )}
                    </TD>
                    <TD>
                      <Badge tone={statusTone(member.status)}>{member.status.toLowerCase()}</Badge>
                    </TD>
                    {canManage && (
                      <TD className="text-right">
                        {manageable ? (
                          <StaffRowActions
                            membershipId={member.id}
                            status={member.status}
                            currentRoleKey={member.membership_roles[0]?.roles?.key ?? null}
                            roles={grantable}
                            branches={auth.tenant.branches.map((b) => ({ id: b.id, name: b.name }))}
                            currentBranchIds={member.membership_branches.map((b) => b.branch_id)}
                          />
                        ) : (
                          <span className="text-xs text-[color:var(--color-ink-muted)]">—</span>
                        )}
                      </TD>
                    )}
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
