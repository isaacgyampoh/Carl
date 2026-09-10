import 'server-only';

/**
 * Where a customer gets Carl.
 *
 * ## Why these are configured, not hard-coded
 *
 * A download URL that points at nothing is worse than no download URL: the owner hands it
 * to a paying customer, and the customer's first experience of Carl is a 404. So the links
 * come from configuration, and when the configuration is absent the console says so
 * plainly rather than rendering a button that cannot work.
 *
 * ## Current reality
 *
 * There are no published releases. CI produces real macOS and Windows artifacts on every
 * desktop build, but they need a GitHub login to fetch and expire after fourteen days,
 * which makes them useless as a customer link. They are also unsigned — macOS Gatekeeper
 * and Windows SmartScreen will both refuse them on a customer's machine.
 *
 * Publishing signed builds to a release is the remaining work. Until that exists, this
 * reports "not yet available", which is the truth.
 */
export interface DownloadTarget {
  readonly platform: 'macOS' | 'Windows';
  readonly url: string | null;
  readonly note: string;
}

export function desktopDownloads(): DownloadTarget[] {
  const mac = process.env.CARL_DOWNLOAD_URL_MACOS?.trim();
  const win = process.env.CARL_DOWNLOAD_URL_WINDOWS?.trim();

  return [
    {
      platform: 'macOS',
      url: mac && mac.length > 0 ? mac : null,
      note: mac ? 'Apple silicon' : 'Not yet published — builds are not signed or released.',
    },
    {
      platform: 'Windows',
      url: win && win.length > 0 ? win : null,
      note: win
        ? 'Windows 10 and later, x64'
        : 'Not yet published — builds are not signed or released.',
    },
  ];
}

/**
 * The address a merchant uses.
 *
 * Every tenant shares one deployment, so this is the application's own URL rather than a
 * per-customer subdomain. Derived from configuration so a preview deployment does not hand
 * out a preview link as though it were permanent.
 */
export function clientAppUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) return configured;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return `https://${vercel}`;

  /*
   * There is no localhost fallback in production.
   *
   * This value is not internal: it becomes the shop address printed on the onboarding
   * handover screen with a Copy button beside it. Falling back to `http://localhost:3000`
   * meant a misconfigured deployment handed a paying merchant a link that resolves to their
   * own machine, and did it silently — the page rendered, the button copied, and the error
   * surfaced days later as "the link you gave me doesn't work".
   *
   * Refusing is louder and cheaper. A 500 on one internal page is visible to the operator
   * who can fix it in a minute; a wrong URL is visible only to the customer.
   */
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'NEXT_PUBLIC_APP_URL is not configured. Refusing to hand out a localhost address as a ' +
        "merchant's shop URL.",
    );
  }
  return 'http://localhost:3000';
}
