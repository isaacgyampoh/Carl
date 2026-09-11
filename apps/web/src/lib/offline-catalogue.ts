/**
 * The catalogue the till holds on the device, and how it is searched without a server.
 *
 * Separate from the storage itself (lib/offline-store.ts, which is IndexedDB and therefore
 * browser-only) so the matching rules are plain code: testable, and readable next to the
 * server-side search they stand in for.
 */
export interface CatalogueItem {
  productId: string;
  name: string;
  sku: string;
  unit: string;
  unitPrice: number;
  quantity: number;
  packSize: number;
  barcodes: string[];
}

/**
 * Matches the way the server's search does, in the order that matters at a counter: a scanned
 * barcode or a typed SKU is an exact answer, and anything else is a list to choose from.
 */
export function searchCatalogue(
  items: readonly CatalogueItem[],
  query: string,
  limit = 20,
): CatalogueItem[] {
  const term = query.trim().toLowerCase();
  if (term.length === 0) return [];

  const exact = items.filter(
    (item) =>
      item.sku.toLowerCase() === term || item.barcodes.some((code) => code.toLowerCase() === term),
  );
  if (exact.length > 0) return exact.slice(0, limit);

  return items
    .filter(
      (item) => item.name.toLowerCase().includes(term) || item.sku.toLowerCase().includes(term),
    )
    .slice(0, limit);
}
