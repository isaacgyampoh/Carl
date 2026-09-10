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
  return vercel ? `https://${vercel}` : 'http://localhost:3000';
}
