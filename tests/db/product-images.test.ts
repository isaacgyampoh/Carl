import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { addMember, createProduct, createTenant } from '../support/fixtures.js';

/**
 * Product images are isolated per business by the database, not by the screen.
 *
 * Objects live at {tenant}/products/{product}/{uuid}.{ext} in a private bucket. These run the
 * real storage policies from migration 0040 against the same table shape Supabase uses, as
 * each business's own signed-in role.
 */
describe('product image isolation', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.reset();
  });

  const pathFor = (tenantId: string, productId: string, ext = 'webp') =>
    `${tenantId}/products/${productId}/${randomUUID()}.${ext}`;

  const put = (userId: string, name: string) =>
    db.asUser(userId, () =>
      db.query(
        `insert into storage.objects (bucket_id, name, metadata) values ('product-images', $1, '{}')`,
        [name],
      ),
    );

  const visible = async (userId: string, name: string) =>
    (
      await db.asUser(userId, () =>
        db.query(`select 1 from storage.objects where bucket_id = 'product-images' and name = $1`, [
          name,
        ]),
      )
    ).rows.length > 0;

  async function twoBusinesses() {
    const a = await createTenant(db);
    const b = await createTenant(db);
    const productA = await createProduct(db, a.tenantId);
    const productB = await createProduct(db, b.tenantId);
    return { a, b, productA, productB };
  }

  it('is a private bucket limited to 2 MB of JPEG, PNG or WebP', async () => {
    const { rows } = await db.asAdmin(() =>
      db.query<{ public: boolean; file_size_limit: string; allowed_mime_types: string[] }>(
        `select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'product-images'`,
      ),
    );
    expect(rows[0]!.public).toBe(false);
    expect(Number(rows[0]!.file_size_limit)).toBe(2 * 1024 * 1024);
    expect([...rows[0]!.allowed_mime_types].sort()).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
  });

  it("lets a business store and read its own product's image", async () => {
    const { a, productA } = await twoBusinesses();
    const name = pathFor(a.tenantId, productA);
    await put(a.ownerUserId, name);
    expect(await visible(a.ownerUserId, name)).toBe(true);
  });

  it("does not let business B read business A's image", async () => {
    const { a, b, productA } = await twoBusinesses();
    const name = pathFor(a.tenantId, productA);
    await put(a.ownerUserId, name);
    expect(await visible(b.ownerUserId, name)).toBe(false);
  });

  it("does not let business B write into business A's folder", async () => {
    const { a, b, productA } = await twoBusinesses();
    await expect(put(b.ownerUserId, pathFor(a.tenantId, productA))).rejects.toThrow(
      /row-level security/,
    );
  });

  it("does not let business B overwrite or delete business A's image", async () => {
    const { a, b, productA } = await twoBusinesses();
    const name = pathFor(a.tenantId, productA);
    await put(a.ownerUserId, name);

    const updated = await db.asUser(b.ownerUserId, () =>
      db.query(`update storage.objects set metadata = '{"hijacked":true}' where name = $1`, [name]),
    );
    const deleted = await db.asUser(b.ownerUserId, () =>
      db.query(`delete from storage.objects where name = $1`, [name]),
    );
    expect(updated.rowCount).toBe(0);
    expect(deleted.rowCount).toBe(0);

    const { rows } = await db.asServiceRole(() =>
      db.query<{ metadata: Record<string, unknown> }>(
        `select metadata from storage.objects where name = $1`,
        [name],
      ),
    );
    expect(rows).toEqual([{ metadata: {} }]);
  });

  it("refuses a path that puts another business's product under your own folder", async () => {
    const { a, productB } = await twoBusinesses();
    await expect(put(a.ownerUserId, pathFor(a.tenantId, productB))).rejects.toThrow(
      /row-level security/,
    );
  });

  it('refuses malformed and traversal paths', async () => {
    const { a, productA } = await twoBusinesses();
    for (const name of [
      `${a.tenantId}/products/${productA}/image.webp`,
      `${a.tenantId}/products/${productA}/${randomUUID()}.svg`,
      `${a.tenantId}/products/${productA}/nested/${randomUUID()}.png`,
      `${a.tenantId}/other/${productA}/${randomUUID()}.png`,
      `../${a.tenantId}/products/${productA}/${randomUUID()}.png`,
      `${randomUUID()}.png`,
    ]) {
      await expect(put(a.ownerUserId, name), name).rejects.toThrow(/row-level security/);
    }
  });

  it('refuses a cashier, who may not change products', async () => {
    const { a, productA } = await twoBusinesses();
    const cashier = await addMember(db, a.tenantId, { roleKey: 'cashier' });
    await expect(put(cashier.userId, pathFor(a.tenantId, productA))).rejects.toThrow(
      /row-level security/,
    );
  });

  it('shows anonymous callers nothing', async () => {
    const { a, productA } = await twoBusinesses();
    const name = pathFor(a.tenantId, productA);
    await put(a.ownerUserId, name);
    const { rows } = await db.asAnon(() =>
      db.query(`select 1 from storage.objects where name = $1`, [name]),
    );
    expect(rows).toHaveLength(0);
  });

  it("keeps a product's image_path inside that product's own folder", async () => {
    const { a, b, productA, productB } = await twoBusinesses();
    const own = pathFor(a.tenantId, productA, 'png');
    await db.asUser(a.ownerUserId, () =>
      db.query(`update products set image_path = $1 where id = $2`, [own, productA]),
    );

    await expect(
      db.asServiceRole(() =>
        db.query(`update products set image_path = $1 where id = $2`, [
          pathFor(b.tenantId, productB),
          productA,
        ]),
      ),
    ).rejects.toThrow(/products_image_path_own_folder/);
    await expect(
      db.asServiceRole(() =>
        db.query(`update products set image_path = $1 where id = $2`, [
          pathFor(a.tenantId, productB),
          productA,
        ]),
      ),
    ).rejects.toThrow(/products_image_path_own_folder/);

    // A product without an image is ordinary.
    await db.asServiceRole(() =>
      db.query(`update products set image_path = null where id = $1`, [productA]),
    );
  });

  it("deleting business A's image leaves business B's untouched", async () => {
    const { a, b, productA, productB } = await twoBusinesses();
    const nameA = pathFor(a.tenantId, productA);
    const nameB = pathFor(b.tenantId, productB);
    await put(a.ownerUserId, nameA);
    await put(b.ownerUserId, nameB);

    await db.asUser(a.ownerUserId, () =>
      db.query(`delete from storage.objects where name = $1`, [nameA]),
    );
    expect(await visible(a.ownerUserId, nameA)).toBe(false);
    expect(await visible(b.ownerUserId, nameB)).toBe(true);
  });
});
