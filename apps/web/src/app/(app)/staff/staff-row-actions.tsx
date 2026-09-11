'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button, Field } from '@carl/ui';

import { formText } from '@/lib/form-data';
import { inputClass } from '@/components/form';
import { resetStaffPin, setStaffRole, setStaffStatus } from '@/server/staff-actions';
import type { RoleOption } from './add-staff-form';

type Panel = 'role' | 'pin' | null;

/**
 * Changing one member of staff.
 *
 * Offered only for people the viewer may manage. The owner and the viewer themselves are
 * never offered here, and the database refuses both — as it refuses anyone holding more
 * authority than the viewer.
 */
export function StaffRowActions({
  membershipId,
  status,
  currentRoleKey,
  roles,
}: {
  membershipId: string;
  status: string;
  currentRoleKey: string | null;
  roles: RoleOption[];
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>(null);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function run(action: () => Promise<{ ok: boolean; message?: string }>, done: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setMessage(result.message ?? 'That could not be done.');
        return;
      }
      setMessage(done);
      setPanel(null);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setPanel(panel === 'role' ? null : 'role')}
        >
          Role
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'pin' ? null : 'pin')}>
          Reset PIN
        </Button>
        {status === 'ACTIVE' ? (
          <Button
            size="sm"
            variant="ghost"
            loading={pending}
            onClick={() =>
              run(() => setStaffStatus({ membershipId, status: 'SUSPENDED' }), 'Suspended.')
            }
          >
            Suspend
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            loading={pending}
            onClick={() =>
              run(() => setStaffStatus({ membershipId, status: 'ACTIVE' }), 'Reactivated.')
            }
          >
            Reactivate
          </Button>
        )}
      </div>

      {panel === 'role' && (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const roleKey = formText(new FormData(event.currentTarget), 'roleKey');
            run(() => setStaffRole({ membershipId, roleKey }), 'Role changed.');
          }}
        >
          <select
            name="roleKey"
            defaultValue={currentRoleKey ?? ''}
            className={`${inputClass} h-9`}
          >
            {roles.map((role) => (
              <option key={role.key} value={role.key}>
                {role.name}
              </option>
            ))}
          </select>
          <Button size="sm" type="submit" loading={pending}>
            Save
          </Button>
        </form>
      )}

      {panel === 'pin' && (
        <form
          className="flex flex-wrap items-end justify-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            run(
              () =>
                resetStaffPin({
                  membershipId,
                  pin: formText(data, 'pin'),
                  confirmPin: formText(data, 'confirmPin'),
                }),
              'New PIN issued. They will choose their own at next sign-in.',
            );
          }}
        >
          <Field
            label="New PIN"
            name="pin"
            type="password"
            inputMode="numeric"
            maxLength={4}
            required
            autoComplete="new-password"
          />
          <Field
            label="Confirm"
            name="confirmPin"
            type="password"
            inputMode="numeric"
            maxLength={4}
            required
            autoComplete="new-password"
          />
          <Button size="sm" type="submit" loading={pending}>
            Issue
          </Button>
        </form>
      )}

      {message && <p className="text-xs text-[color:var(--color-ink-muted)]">{message}</p>}
    </div>
  );
}
