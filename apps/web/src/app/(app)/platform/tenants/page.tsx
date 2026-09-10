import { permanentRedirect } from 'next/navigation';

/**
 * Superseded by `/platform/clients`.
 *
 * Kept as a redirect rather than deleted: this URL was linked from the platform dashboard
 * and may be bookmarked. Two pages listing the same businesses under different names is
 * how an operator ends up trusting whichever one they happened to open.
 */
export default function TenantsPage(): never {
  permanentRedirect('/platform/clients');
}
