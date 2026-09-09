import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AuthContext } from '@carl/application';
import { hasAnyPermission } from '@carl/application';
import { Permission } from '@carl/domain';
import { Badge, statusTone } from '@carl/ui';

import { BranchSwitcher } from './branch-switcher';
import { NavLink } from './nav-link';
import { SignOutButton } from './sign-out-button';

/**
 * Navigation, filtered by what the user can actually do.
 *
 * Hiding a link is a courtesy, not a control — the route behind it re-checks, and the
 * database refuses regardless. The point is that a cashier should not spend their shift
 * looking at seven areas they will be turned away from.
 *
 * `permissions` lists what makes a section reachable; holding any one is enough.
 */
interface NavItem {
  href: string;
  label: string;
  permissions: readonly Permission[];
}

const NAV_SECTIONS: readonly { heading: string; items: readonly NavItem[] }[] = [
  {
    heading: 'Trade',
    items: [
      { href: '/', label: 'Dashboard', permissions: [] },
      { href: '/pos', label: 'Point of sale', permissions: [Permission.SALES_CREATE] },
      { href: '/sales', label: 'Sales', permissions: [Permission.SALES_VIEW] },
      { href: '/customers', label: 'Customers', permissions: [Permission.CUSTOMERS_VIEW] },
    ],
  },
  {
    heading: 'Stock',
    items: [
      { href: '/products', label: 'Products', permissions: [Permission.PRODUCTS_VIEW] },
      { href: '/inventory', label: 'Inventory', permissions: [Permission.INVENTORY_VIEW] },
      {
        href: '/transfers',
        label: 'Transfers',
        permissions: [Permission.INVENTORY_VIEW],
      },
      { href: '/purchases', label: 'Purchases', permissions: [Permission.PURCHASES_VIEW] },
      { href: '/suppliers', label: 'Suppliers', permissions: [Permission.SUPPLIERS_VIEW] },
    ],
  },
  {
    heading: 'Money',
    items: [
      { href: '/expenses', label: 'Expenses', permissions: [Permission.EXPENSES_VIEW] },
      { href: '/register', label: 'Cash register', permissions: [Permission.REGISTER_OPEN] },
      { href: '/reports', label: 'Reports', permissions: [Permission.REPORTS_VIEW] },
    ],
  },
  {
    heading: 'Business',
    items: [
      { href: '/branches', label: 'Branches', permissions: [Permission.BRANCHES_VIEW] },
      { href: '/staff', label: 'Staff', permissions: [Permission.STAFF_VIEW] },
      { href: '/devices', label: 'Terminals', permissions: [Permission.DEVICES_VIEW] },
      { href: '/settings', label: 'Settings', permissions: [Permission.SETTINGS_VIEW] },
    ],
  },
];

export function AppShell({ auth, children }: { auth: AuthContext; children: ReactNode }) {
  const tenant = auth.tenant;

  const sections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) => item.permissions.length === 0 || hasAnyPermission(auth, item.permissions),
    ),
  })).filter((section) => section.items.length > 0);

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      {/* Sidebar: a fixed rail on desktop, where it is always in reach without a tap. */}
      <aside className="hidden w-60 shrink-0 border-r border-[color:var(--color-border)] bg-[color:var(--color-surface)] lg:flex lg:flex-col">
        <div className="border-b border-[color:var(--color-border)] px-5 py-4">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            Carl
          </Link>
          {tenant && (
            <p className="mt-0.5 truncate text-sm text-[color:var(--color-ink-muted)]">
              {tenant.tenantName}
            </p>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Main">
          {sections.map((section) => (
            <div key={section.heading} className="mb-5 last:mb-0">
              <p className="px-2 pb-1.5 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-ink-muted)]">
                {section.heading}
              </p>
              <ul className="flex flex-col gap-0.5">
                {section.items.map((item) => (
                  <li key={item.href}>
                    <NavLink href={item.href}>{item.label}</NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {auth.user.isPlatformAdmin && (
            <div className="mt-6 border-t border-[color:var(--color-border)] pt-4">
              <p className="px-2 pb-1.5 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-ink-muted)]">
                Carl platform
              </p>
              <ul className="flex flex-col gap-0.5">
                <li>
                  <NavLink href="/platform">Overview</NavLink>
                </li>
                <li>
                  <NavLink href="/platform/tenants">Businesses</NavLink>
                </li>
                <li>
                  <NavLink href="/platform/installations">Installations</NavLink>
                </li>
                <li>
                  <NavLink href="/platform/maintenance">Maintenance</NavLink>
                </li>
              </ul>
            </div>
          )}
        </nav>

        <div className="border-t border-[color:var(--color-border)] px-3 py-3">
          <div className="px-2 pb-2">
            <p className="truncate text-sm font-medium">{auth.user.fullName}</p>
            <p className="truncate text-xs text-[color:var(--color-ink-muted)]">
              {auth.user.email}
            </p>
          </div>
          <SignOutButton />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-4 lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="text-base font-semibold lg:hidden">Carl</span>
            {tenant && <BranchSwitcher tenant={tenant} />}
          </div>

          {tenant && tenant.status !== 'ACTIVE' && (
            <Badge tone={statusTone(tenant.status)}>{tenant.status.replace('_', ' ')}</Badge>
          )}
        </header>

        <main className="min-w-0 flex-1 px-4 py-5 lg:px-6 lg:py-6">{children}</main>

        {/* Bottom navigation on mobile: the four things a phone user actually does. */}
        <nav
          className="sticky bottom-0 flex shrink-0 border-t border-[color:var(--color-border)] bg-[color:var(--color-surface)] lg:hidden"
          aria-label="Primary"
        >
          {sections
            .flatMap((section) => section.items)
            .slice(0, 4)
            .map((item) => (
              <NavLink key={item.href} href={item.href} variant="bottom">
                {item.label}
              </NavLink>
            ))}
        </nav>
      </div>
    </div>
  );
}
