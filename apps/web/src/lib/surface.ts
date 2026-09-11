/**
 * Carl's two application experiences, and which one a request belongs to.
 *
 * ## The owner console
 *
 * The main address, `/`, is the platform owner's PIN entry, and `/platform/...` is the console
 * behind it: onboarding, clients, billing, terminals, platform settings. It is used in a
 * browser at the main address. It is not the installed application.
 *
 * ## A business
 *
 * Everything else. A business's own address (`/{slug}`) leads to its portal; its POS entry
 * (`/{slug}/pos`) leads to the till; and the screens behind both (/dashboard, /pos, /products,
 * ...) are shared routes. The installed PWA is the POS client, and it lives here.
 *
 * ## Why each has its own session cookie
 *
 * All of Carl is one origin, and on Android and desktop an installed app shares the browser's
 * cookie jar. With a single session cookie, a PIN typed at any shop's door on the owner's
 * phone replaced the owner's session: the next time the owner opened their console they were
 * that shop's staff, bounced to /no-access, whose only way onward was the business dashboard.
 * Signing in to the till logged the owner out of the console, and the console of the till.
 *
 * So the owner console reads and writes `OWNER_SESSION_COOKIE`, and a business uses Supabase's
 * default. Signing in to one never touches the other.
 *
 * The surface decides WHICH cookie is read, and nothing more. It grants nothing: the owner
 * cookie must still carry a session the Auth server verifies, for an account listed in
 * `platform_admins`, and every query is still filtered by RLS.
 *
 * Pure, so the proxy, the render code and the tests share one definition.
 */
export type Surface = 'owner' | 'business';

/**
 * Carries the surface from the proxy to the render code. The proxy overwrites it on every
 * request, so a browser sending its own value changes nothing.
 */
export const SURFACE_HEADER = 'x-carl-surface';

/** The owner console's session cookie. A business's session uses Supabase's default name. */
export const OWNER_SESSION_COOKIE = 'carl-owner-session';

export function surfaceFor(pathname: string): Surface {
  return pathname === '/' || pathname === '/platform' || pathname.startsWith('/platform/')
    ? 'owner'
    : 'business';
}

/**
 * The hostnames each application answers on, when they have been split.
 *
 * One origin can only go so far. An installed till app claims its whole origin on Android, so
 * a link to Carl's main address tapped in another app can open inside the till. Two hostnames
 * end that: the console's own name is not the app's, and nothing installed from the shops'
 * address can capture it.
 *
 * Unset, Carl runs on one hostname and the path decides, exactly as before — so this is
 * configuration, not a second architecture.
 */
export interface Hosts {
  /** Where the owner console answers, e.g. owner.thecarl.cc. */
  readonly owner: string | null;
  /** Where businesses and their tills answer, e.g. thecarl.cc. */
  readonly app: string | null;
}

export function hostOf(header: string | null | undefined): string {
  // Port and case are not part of a hostname's identity here; a forwarded port is common in
  // development and behind proxies.
  return (header ?? '').split(':')[0]?.trim().toLowerCase() ?? '';
}

export function surfaceForRequest(pathname: string, host: string, hosts: Hosts): Surface {
  if (!hosts.owner) return surfaceFor(pathname);
  // With the console on its own hostname, the hostname decides and the path does not: the
  // shops' address must not serve the console at all, whatever path is asked for.
  return hostOf(host) === hosts.owner ? 'owner' : 'business';
}

/** Where a path belongs when the two are on separate hostnames, or null when it is fine here. */
export function movedTo(pathname: string, host: string, hosts: Hosts): string | null {
  if (!hosts.owner || !hosts.app) return null;
  const current = hostOf(host);
  const belongsToOwner = surfaceFor(pathname) === 'owner' && pathname !== '/';
  if (belongsToOwner && current === hosts.app) return `https://${hosts.owner}${pathname}`;
  // The console's hostname serves the console and its entry, and nothing of a business.
  if (!belongsToOwner && pathname !== '/' && current === hosts.owner) {
    return `https://${hosts.app}${pathname}`;
  }
  return null;
}

/** Anything but the proxy's own `owner` is a business request. */
export function surfaceFromHeader(value: string | null | undefined): Surface {
  return value === 'owner' ? 'owner' : 'business';
}
