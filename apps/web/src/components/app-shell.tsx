import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import type { AuthContext } from '@carl/application';
import { hasAnyPermission } from '@carl/application';
import { Permission } from '@carl/domain';
import {
  Activity,
  ArrowLeftRight,
  Badge,
  Boxes,
  Building2,
  Calculator,
  ChartColumn,
  CreditCard,
  FileText,
  LayoutDashboard,
  MonitorSmartphone,
  Package,
  Receipt,
  Settings,
  ShoppingCart,
  Store,
  Truck,
  UserCog,
  UserPlus,
  Users,
  Wallet,
  statusTone,
  type LucideIcon,
} from '@carl/ui';

import { BranchSwitcher } from './branch-switcher';
import { MobileTabBar, type MobileNavGroup, type MobileNavItem } from './mobile-nav';
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
  /** For the tablet rail and the phone tab bar, where the full label does not fit. */
  short?: string;
  icon: LucideIcon;
  permissions: readonly Permission[];
}

const NAV_SECTIONS: readonly { heading: string; items: readonly NavItem[] }[] = [
  {
    heading: 'Trade',
    items: [
      // Hidden from a cashier, whose dashboard is the till.
      {
        href: '/dashboard',
        label: 'Dashboard',
        short: 'Home',
        icon: LayoutDashboard,
        permissions: [Permission.REPORTS_VIEW, Permission.INVENTORY_VIEW],
      },
      {
        href: '/pos',
        label: 'Point of sale',
        short: 'Sell',
        icon: ShoppingCart,
        permissions: [Permission.SALES_CREATE],
      },
      { href: '/sales', label: 'Sales', icon: Receipt, permissions: [Permission.SALES_VIEW] },
      {
        href: '/customers',
        label: 'Customers',
        icon: Users,
        permissions: [Permission.CUSTOMERS_VIEW],
      },
    ],
  },
  {
    heading: 'Stock',
    items: [
      {
        href: '/products',
        label: 'Products',
        icon: Package,
        permissions: [Permission.PRODUCTS_VIEW],
      },
      {
        href: '/inventory',
        label: 'Inventory',
        short: 'Stock',
        icon: Boxes,
        permissions: [Permission.INVENTORY_VIEW],
      },
      {
        href: '/transfers',
        label: 'Transfers',
        icon: ArrowLeftRight,
        permissions: [Permission.INVENTORY_VIEW],
      },
      {
        href: '/purchases',
        label: 'Purchases',
        icon: Truck,
        permissions: [Permission.PURCHASES_VIEW],
      },
      {
        href: '/suppliers',
        label: 'Suppliers',
        icon: Building2,
        permissions: [Permission.SUPPLIERS_VIEW],
      },
    ],
  },
  {
    heading: 'Money',
    items: [
      {
        href: '/expenses',
        label: 'Expenses',
        icon: Wallet,
        permissions: [Permission.EXPENSES_VIEW],
      },
      {
        href: '/register',
        label: 'Cash register',
        short: 'Register',
        icon: Calculator,
        permissions: [Permission.REGISTER_OPEN],
      },
      {
        href: '/reports',
        label: 'Reports',
        icon: ChartColumn,
        permissions: [Permission.REPORTS_VIEW],
      },
    ],
  },
  {
    heading: 'Business',
    items: [
      {
        href: '/branches',
        label: 'Branches',
        icon: Store,
        permissions: [Permission.BRANCHES_VIEW],
      },
      { href: '/staff', label: 'Staff', icon: UserCog, permissions: [Permission.STAFF_VIEW] },
      {
        href: '/devices',
        label: 'Terminals',
        icon: MonitorSmartphone,
        permissions: [Permission.DEVICES_VIEW],
      },
      {
        href: '/settings',
        label: 'Settings',
        icon: Settings,
        permissions: [Permission.SETTINGS_MANAGE],
      },
    ],
  },
];

/** The owner console's sections, in the order an operator reaches for them. */
export const PLATFORM_NAV: readonly (readonly [href: string, label: string])[] = [
  ['/platform', 'Overview'],
  ['/platform/clients', 'Clients'],
  ['/platform/onboarding', 'Add client'],
  ['/platform/billing', 'Billing'],
  ['/platform/invoices', 'Invoices'],
  ['/platform/devices', 'Terminals'],
  ['/platform/branches', 'Branches'],
  ['/platform/audit', 'Activity'],
  ['/platform/settings', 'Settings'],
];

const PLATFORM_ICONS: Readonly<Record<string, LucideIcon>> = {
  '/platform': LayoutDashboard,
  '/platform/clients': Building2,
  '/platform/onboarding': UserPlus,
  '/platform/billing': CreditCard,
  '/platform/invoices': FileText,
  '/platform/devices': MonitorSmartphone,
  '/platform/branches': Store,
  '/platform/audit': Activity,
  '/platform/settings': Settings,
};

/**
 * The order the phone's tab bar fills from: what each kind of person reaches for most. A
 * cashier gets Sell first; an owner gets Home; the platform owner gets their console.
 */
const TAB_PRIORITY = [
  '/pos',
  '/dashboard',
  '/sales',
  '/products',
  '/inventory',
  '/customers',
  '/register',
  '/reports',
  '/platform',
  '/platform/clients',
  '/platform/billing',
  '/platform/onboarding',
];
/** Five is what a phone's width holds at a readable label size; the fifth becomes More. */
const MAX_TABS = 5;

interface ShellItem {
  href: string;
  label: string;
  short?: string | undefined;
  Icon: LucideIcon;
  exact?: boolean | undefined;
}

export function AppShell({ auth, children }: { auth: AuthContext; children: ReactNode }) {
  const tenant = auth.tenant;

  const groups: { heading: string; items: ShellItem[] }[] = NAV_SECTIONS.map((section) => ({
    heading: section.heading,
    items: section.items
      .filter((item) => item.permissions.length === 0 || hasAnyPermission(auth, item.permissions))
      .map((item) => ({ href: item.href, label: item.label, short: item.short, Icon: item.icon })),
  })).filter((group) => group.items.length > 0);

  if (auth.user.isPlatformAdmin) {
    groups.push({
      heading: 'Carl platform',
      items: PLATFORM_NAV.map(([href, label]) => ({
        href,
        label,
        Icon: PLATFORM_ICONS[href] ?? Settings,
        // The console's front page must not stay lit on every page beneath it.
        exact: href === '/platform',
      })),
    });
  }

  // Phone tabs: everything if it fits, otherwise the most-used four plus a More sheet.
  const all = groups.flatMap((group) => group.items);
  const rank = (item: ShellItem) => {
    const index = TAB_PRIORITY.indexOf(item.href);
    return index === -1 ? TAB_PRIORITY.length + all.indexOf(item) : index;
  };
  const fits = all.length <= MAX_TABS;
  const tabItems = fits ? all : [...all].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_TABS - 1);
  const inTabs = new Set(tabItems.map((item) => item.href));

  const toMobile = ({ href, label, short, Icon, exact }: ShellItem): MobileNavItem => ({
    href,
    label,
    short,
    icon: <Icon />,
    exact,
  });
  const tabs = tabItems.map(toMobile);
  const more: MobileNavGroup[] = fits
    ? []
    : groups
        .map((group) => ({
          heading: group.heading,
          items: group.items.filter((item) => !inTabs.has(item.href)).map(toMobile),
        }))
        .filter((group) => group.items.length > 0);

  const home = tenant ? '/dashboard' : '/platform';

  return (
    /*
     * The shell is the height of the screen and only its content area scrolls, the way an
     * installed app behaves: the header and navigation never scroll away, and the till can
     * fill exactly the space between them without guessing at pixel offsets.
     */
    <div
      data-shell
      className="flex h-dvh overflow-hidden pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
    >
      {/* Desktop: the full sidebar, always in reach without a tap. */}
      <aside className="hidden w-60 shrink-0 select-none border-r border-[color:var(--color-border)] bg-[color:var(--color-surface)] lg:flex lg:flex-col">
        <div className="border-b border-[color:var(--color-border)] px-5 py-4">
          <Link href={home} className="text-lg font-semibold tracking-tight">
            Carl
          </Link>
          {tenant && (
            <p className="mt-0.5 truncate text-sm text-[color:var(--color-ink-muted)]">
              {tenant.tenantName}
            </p>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Main">
          {groups.map((group) => (
            <div key={group.heading} className="mb-5 last:mb-0">
              <p className="px-2 pb-1.5 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-ink-muted)]">
                {group.heading}
              </p>
              <ul className="flex flex-col gap-0.5">
                {group.items.map(({ href, label, Icon, exact }) => (
                  <li key={href}>
                    <NavLink href={href} icon={<Icon />} exact={exact}>
                      {label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
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

      {/*
       * Tablet: a navigation rail. Below the desktop width a tablet used to get the phone's
       * bar, so an iPad held upright showed a strip of scrolling text labels along its
       * bottom edge.
       */}
      <nav
        aria-label="Main"
        className="hidden w-[5.5rem] shrink-0 select-none flex-col border-r border-[color:var(--color-border)] bg-[color:var(--color-surface)] md:flex lg:hidden"
      >
        <div className="box-content flex h-14 shrink-0 items-center justify-center border-b border-[color:var(--color-border)] pt-[env(safe-area-inset-top)]">
          <Link href={home} className="text-base font-semibold tracking-tight">
            Carl
          </Link>
        </div>
        <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain px-2 py-3">
          {groups.map((group, index) => (
            <Fragment key={group.heading}>
              {index > 0 && (
                <li aria-hidden className="mx-3 my-1 border-t border-[color:var(--color-border)]" />
              )}
              {group.items.map(({ href, label, short, Icon, exact }) => (
                <li key={href}>
                  <NavLink href={href} icon={<Icon />} exact={exact} variant="rail">
                    {short ?? label}
                  </NavLink>
                </li>
              ))}
            </Fragment>
          ))}
        </ul>
        <div className="shrink-0 border-t border-[color:var(--color-border)] px-1.5 py-2">
          <SignOutButton />
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-[color:var(--color-border)] bg-[color:var(--color-surface)] pt-[env(safe-area-inset-top)]">
          <div className="flex h-14 items-center justify-between gap-3 px-4 md:px-6">
            <div className="flex min-w-0 items-center gap-3">
              {/* Below desktop there is no sidebar naming the business, so the header does. */}
              <p className="min-w-0 truncate text-base font-semibold lg:hidden">
                {tenant?.tenantName ?? 'Carl'}
              </p>
              {tenant && <BranchSwitcher tenant={tenant} />}
            </div>

            {tenant && tenant.status !== 'ACTIVE' && (
              <Badge tone={statusTone(tenant.status)}>{tenant.status.replace('_', ' ')}</Badge>
            )}
          </div>
        </header>

        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 md:px-6 lg:py-6">
          {children}
        </main>

        <MobileTabBar
          tabs={tabs}
          more={more}
          userName={auth.user.fullName}
          userEmail={auth.user.email}
        />
      </div>
    </div>
  );
}
