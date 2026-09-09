import type { Metadata } from 'next';
import { Permission } from '@carl/domain';
import { Badge, Card, EmptyState, Table, TBody, TD, TH, THead, TR, statusTone } from '@carl/ui';

import { requirePermission } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { PageHeader } from '@/components/page-header';

export const metadata: Metadata = { title: 'Staff' };
export const dynamic = 'force-dynamic';

interface MembershipRow {
  id: string;
  status: string;
  is_owner: boolean;
  job_title: string | null;
  staff_code: string | null;
  accepted_at: string | null;
  profiles: { full_name: string; email: string } | null;
  membership_roles: { roles: { name: string; key: string } | null; branch_id: string | null }[];
  membership_branches: { branches: { name: string } | null }[];
}

export default async function StaffPage() {
  await requirePermission(Permission.STAFF_VIEW);

  const client = await supabase();
  const { data } = await client
    .from('tenant_memberships')
    .select(
      `id, status, is_owner, job_title, staff_code, accepted_at,
       profiles(full_name, email),
       membership_roles(branch_id, roles(name, key)),
       membership_branches(branches(name))`,
    )
    .neq('status', 'REMOVED')
    .returns<MembershipRow[]>();

  const staff = data ?? [];

  return (
    <>
      <PageHeader
        title="Staff"
        description="Who works here and what they may do. A member with no role can see nothing."
      />

      <Card className="overflow-hidden">
        {staff.length === 0 ? (
          <EmptyState title="No staff yet" description="Invite someone to give them access." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Person</TH>
                <TH>Roles</TH>
                <TH>Branches</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {staff.map((member) => (
                <TR key={member.id}>
                  <TD>
                    <span className="font-medium">{member.profiles?.full_name}</span>
                    <span className="block text-xs text-[color:var(--color-ink-muted)]">
                      {member.profiles?.email}
                      {member.job_title && ` · ${member.job_title}`}
                    </span>
                  </TD>
                  <TD>
                    <div className="flex flex-wrap gap-1.5">
                      {member.is_owner && <Badge tone="brand">Owner</Badge>}
                      {member.membership_roles.length === 0 && !member.is_owner ? (
                        <span className="text-xs text-[color:var(--color-warning)]">
                          No role — cannot see anything
                        </span>
                      ) : (
                        member.membership_roles.map((assignment, index) => (
                          <Badge key={index} tone="neutral">
                            {assignment.roles?.name}
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
                        .map((assignment) => assignment.branches?.name)
                        .filter(Boolean)
                        .join(', ')
                    )}
                  </TD>
                  <TD>
                    <Badge tone={statusTone(member.status)}>{member.status.toLowerCase()}</Badge>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
