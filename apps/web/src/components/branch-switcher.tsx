'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import type { TenantContext } from '@carl/application';

/**
 * Chooses which branch the session is operating in.
 *
 * The selection is a URL parameter rather than client state so that a server-rendered page
 * knows the branch on first paint, and so a link to "Kumasi's stock" can be shared.
 *
 * It is not a grant. The server treats it as a filter over branches the database already
 * says this user may reach, so requesting a branch you cannot access selects nothing.
 */
export function BranchSwitcher({ tenant }: { tenant: TenantContext }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  // One branch means there is nothing to switch between; a disabled dropdown would just be
  // clutter on every screen.
  if (tenant.branches.length <= 1) return null;

  return (
    <label className="flex min-w-0 items-center gap-2 text-sm">
      <span className="sr-only">Branch</span>
      <select
        className="h-8 max-w-48 truncate rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 text-sm"
        value={tenant.activeBranchId ?? ''}
        disabled={pending}
        onChange={(event) => {
          const params = new URLSearchParams(searchParams.toString());
          params.set('branch', event.target.value);
          startTransition(() => router.replace(`${pathname}?${params.toString()}`));
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
