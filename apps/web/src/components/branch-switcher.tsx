'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import type { TenantContext } from '@carl/application';

import { selectBranch } from '@/server/context-actions';

/**
 * Chooses which branch the session is operating in.
 *
 * The choice is recorded on the server (a cookie `currentAuth` reads), so every
 * server-rendered page — stock, sales, reports, the till — operates in the chosen branch.
 * It used to be a `?branch=` URL parameter that nothing on the server read, so a business
 * with two branches always saw its first.
 *
 * It is not a grant. The server treats it as a filter over branches the database already
 * says this user may reach, so requesting a branch you cannot access selects nothing.
 */
export function BranchSwitcher({ tenant }: { tenant: TenantContext }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // One branch means there is nothing to switch between; a disabled dropdown would just be
  // clutter on every screen.
  if (tenant.branches.length <= 1) return null;

  return (
    <label className="flex min-w-0 items-center gap-2 text-sm">
      <span className="sr-only">Branch</span>
      <select
        className="pointer-coarse:h-10 h-9 max-w-40 truncate rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 text-sm sm:max-w-48"
        value={tenant.activeBranchId ?? ''}
        disabled={pending}
        onChange={(event) => {
          const branchId = event.target.value;
          startTransition(async () => {
            const result = await selectBranch({ branchId });
            if (result.ok) router.refresh();
          });
        }}
      >
        {tenant.branches.map((branch) => (
          <option key={branch.id} value={branch.id}>
            {branch.name}
          </option>
        ))}
      </select>
    </label>
  );
}
