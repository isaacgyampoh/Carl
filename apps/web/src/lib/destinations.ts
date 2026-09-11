import { hasPermission, type AuthContext } from '@carl/application';
import { Permission } from '@carl/domain';

/**
 * Where a person goes once they are signed in.
 *
 * Decided on the server from the verified session and the database's own grants, never from
 * anything the browser says about who someone is. Every sign-in used to end in the same place
 * (`/dashboard`, or `/` for an emailed link, which is now the owner's entry), so a cashier, a
 * shop's administrator and the till app all landed on one screen and relied on that screen to
 * send them onward.
 *
 * Which ENTRY was used is the one thing the browser supplies: the till app's door (`pos`) or
 * the business's own address (`portal`). That is a choice of experience, not a claim of
 * identity: the destination is still checked against what the session may do, and every page
 * enforces its own permission regardless.
 */
export type BusinessEntry = 'portal' | 'pos';

export function entryFrom(value: string | null | undefined): BusinessEntry {
  return value === 'pos' ? 'pos' : 'portal';
}

export function businessDestination(auth: AuthContext | null, entry: BusinessEntry): string {
  if (!auth?.tenant) return '/no-access';
  const canSell = hasPermission(auth, Permission.SALES_CREATE);

  // The till app is a till. Anyone who opens it and may sell gets the POS, including a
  // business's administrator; the portal is reached at the business's address instead.
  if (entry === 'pos') return canSell ? '/pos' : '/no-access';

  // The portal: a cashier's work is the till, everyone else starts on the dashboard. The same
  // rule the dashboard applies, so the two cannot disagree.
  return canSell && !hasPermission(auth, Permission.REPORTS_VIEW) ? '/pos' : '/dashboard';
}

/** A console screen to return to after the owner's PIN, or the console's front page. */
export function ownerDestination(next: string | null | undefined): string {
  if (!next) return '/platform';
  const path = next.split(/[?#]/)[0] ?? '';
  const withinConsole = path === '/platform' || path.startsWith('/platform/');
  // Confined to the console: no other surface, no protocol-relative host, no climbing out.
  if (!withinConsole || next.startsWith('//') || next.includes('..') || next.includes('\\')) {
    return '/platform';
  }
  return next;
}
