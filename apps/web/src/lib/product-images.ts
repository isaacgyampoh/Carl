import 'server-only';

import type { CarlSupabaseClient } from './supabase';

export const PRODUCT_IMAGE_BUCKET = 'product-images';

/**
 * Short-lived URLs for product images, keyed by storage path.
 *
 * The bucket is private. Storage signs a URL only for a path the caller's own session may
 * read under the bucket's RLS policies, so a page can never be handed another business's
 * image, whatever path it asks for. One round trip for a whole list.
 */
export async function signedProductImageUrls(
  client: CarlSupabaseClient,
  paths: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(paths.filter((path): path is string => Boolean(path)))];
  if (unique.length === 0) return new Map();

  const { data } = await client.storage.from(PRODUCT_IMAGE_BUCKET).createSignedUrls(unique, 3600);
  const urls = new Map<string, string>();
  for (const entry of data ?? []) {
    if (entry.path && entry.signedUrl && !entry.error) urls.set(entry.path, entry.signedUrl);
  }
  return urls;
}
