/**
 * Where a signed-out request goes when it belongs to a business.
 *
 * Staff sign in with a PIN at their business's own address. Every signed-out request for an
 * application screen used to be sent to /sign-in, the email-and-password page, which a PIN
 * user cannot use. A cashier whose session ended on /pos, or anyone reaching /{slug}/enter
 * without a session, hit a dead end instead of their business's door.
 *
 * The door comes from the address when it names a business (/{slug}/...), otherwise from the
 * business this device last signed in at with a PIN. It is a destination, never a grant: the
 * door itself asks for a PIN, and a business that does not exist looks the same as one that
 * does.
 *
 * Pure, so the proxy and its tests share one implementation. `isShopSlug` is supplied by the
 * proxy, which owns the reserved route names.
 */
export const DOOR_COOKIE = 'carl_door';

export function shopDoor(
  pathname: string,
  doorCookie: string | undefined,
  isShopSlug: (segment: string) => boolean,
): string | null {
  const [first] = pathname.slice(1).split(/\//);
  if (first && isShopSlug(first)) return `/${first}`;
  if (doorCookie && isShopSlug(doorCookie)) return `/${doorCookie}`;
  return null;
}
