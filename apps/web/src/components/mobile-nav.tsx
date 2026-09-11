'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Ellipsis, X } from '@carl/ui';

import { isActivePath, navClasses, NavLink } from './nav-link';
import { SignOutButton } from './sign-out-button';

export interface MobileNavItem {
  href: string;
  label: string;
  short?: string | undefined;
  icon: ReactNode;
  exact?: boolean | undefined;
}

export interface MobileNavGroup {
  heading: string;
  items: MobileNavItem[];
}

/**
 * The phone's navigation: a tab bar of the sections this person uses most, and a sheet
 * holding everything else.
 *
 * It replaces one bar carrying every section as a text label scrolling sideways: fifteen
 * labels, most of them off-screen, with nothing to say more existed. Tabs with a More sheet
 * is the pattern every native phone app has taught, and each tab is a full-height thumb
 * target. Sign out lives in the sheet, where it cannot be hit by accident mid-sale.
 */
export function MobileTabBar({
  tabs,
  more,
  userName,
  userEmail,
}: {
  tabs: MobileNavItem[];
  more: MobileNavGroup[];
  userName: string;
  userEmail: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const moreActive = more.some((group) =>
    group.items.some((item) => isActivePath(pathname, item.href, item.exact)),
  );

  return (
    <>
      <nav
        aria-label="Primary"
        className="flex shrink-0 select-none border-t border-[color:var(--color-border)] bg-[color:var(--color-surface)] pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {tabs.map((tab) => (
          <NavLink key={tab.href} href={tab.href} icon={tab.icon} exact={tab.exact} variant="tab">
            {tab.short ?? tab.label}
          </NavLink>
        ))}
        {more.length > 0 && (
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className={navClasses('tab', moreActive)}
          >
            <span aria-hidden className="flex shrink-0">
              <Ellipsis />
            </span>
            <span>More</span>
          </button>
        )}
      </nav>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="All sections"
          className="fixed inset-0 z-50 md:hidden"
        >
          <button
            type="button"
            aria-label="Close"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="absolute inset-0 h-full w-full bg-black/40"
          />
          <div className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-2xl bg-[color:var(--color-surface)] pb-[env(safe-area-inset-bottom)] shadow-xl">
            <div
              aria-hidden
              className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-[color:var(--color-border)]"
            />
            <div className="flex shrink-0 items-center justify-between gap-3 px-5 pb-1 pt-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{userName}</p>
                <p className="truncate text-xs text-[color:var(--color-ink-muted)]">{userEmail}</p>
              </div>
              <Button
                ref={closeRef}
                variant="ghost"
                size="icon"
                aria-label="Close"
                onClick={() => setOpen(false)}
              >
                <X className="size-5" />
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2">
              {more.map((group) => (
                <section key={group.heading} className="mt-3">
                  <h2 className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-ink-muted)]">
                    {group.heading}
                  </h2>
                  <ul className="grid gap-0.5 min-[400px]:grid-cols-2">
                    {group.items.map((item) => (
                      <li key={item.href}>
                        <NavLink
                          href={item.href}
                          icon={item.icon}
                          exact={item.exact}
                          variant="sheet"
                          onClick={() => setOpen(false)}
                        >
                          {item.label}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>

            <div className="shrink-0 border-t border-[color:var(--color-border)] px-4 py-3">
              <SignOutButton />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
