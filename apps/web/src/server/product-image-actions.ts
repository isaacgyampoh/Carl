'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { hasPermission } from '@carl/application';
import { Permission } from '@carl/domain';
import { createLogger } from '@carl/shared';
import { z } from '@carl/validation';

import { requireTenant } from '@/lib/auth';
import { PRODUCT_IMAGE_BUCKET } from '@/lib/product-images';
import { supabase } from '@/lib/supabase';
import { actionFailed, actionOk, toActionResult, type ActionResult } from './errors';

const log = createLogger({ level: 'info', base: { module: 'product-image-actions' } });

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * What the file actually is, from its first bytes.
 *
 * A file's name and its declared type are whatever the browser was told. An HTML page renamed
 * to photo.png is still HTML, so the type is decided here from the content, and Storage
 * receives the type this detected rather than the one the upload claimed.
 */
function detectImage(
  bytes: Uint8Array,
): { ext: 'jpg' | 'png' | 'webp'; contentType: string } | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { ext: 'jpg', contentType: 'image/jpeg' };
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return { ext: 'png', contentType: 'image/png' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP')
    return { ext: 'webp', contentType: 'image/webp' };
  return null;
}

async function loadProduct(productId: string) {
  const auth = await requireTenant();
  if (!hasPermission(auth, Permission.PRODUCTS_UPDATE))
    return { auth, product: null, allowed: false };
  const client = await supabase();
  const { data: product } = await client
    .from('products')
    .select('id, image_path')
    .eq('tenant_id', auth.tenant.tenantId)
    .eq('id', productId)
    .maybeSingle();
  return { auth, client, product, allowed: true };
}

/**
 * Stores a product's image and points the product at it.
 *
 * The path is built here from the verified session's business and the product id. It is not
 * accepted from the browser. Both the storage policy and a CHECK on products.image_path
 * refuse anything outside {tenant}/products/{product}/ independently of this code.
 */
export async function uploadProductImage(form: FormData): Promise<ActionResult<{ path: string }>> {
  try {
    const productId = z.uuid().parse(form.get('productId'));
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) {
      return actionFailed('VALIDATION_FAILED', 'Choose an image to upload.');
    }
    if (file.size > MAX_BYTES) {
      return actionFailed('VALIDATION_FAILED', 'The image must be 2 MB or smaller.');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const image = detectImage(bytes);
    if (!image) return actionFailed('VALIDATION_FAILED', 'Use a JPEG, PNG or WebP image.');

    const { auth, client, product, allowed } = await loadProduct(productId);
    if (!allowed)
      return actionFailed('PERMISSION_DENIED', 'You do not have permission to change products.');
    if (!product || !client) return actionFailed('NOT_FOUND', 'That product does not exist.');

    const path = `${auth.tenant.tenantId}/products/${productId}/${randomUUID()}.${image.ext}`;
    const { error: uploadError } = await client.storage
      .from(PRODUCT_IMAGE_BUCKET)
      .upload(path, bytes, { contentType: image.contentType, upsert: false, cacheControl: '3600' });
    if (uploadError) {
      log.warn('product image upload failed', {
        tenantId: auth.tenant.tenantId,
        productId,
        reason: uploadError.message,
      });
      return actionFailed(
        'UPLOAD_FAILED',
        'The image could not be uploaded. Check the connection and try again.',
      );
    }

    const { data: updated, error: updateError } = await client
      .from('products')
      .update({ image_path: path })
      .eq('tenant_id', auth.tenant.tenantId)
      .eq('id', productId)
      .select('id')
      .maybeSingle();
    if (updateError || !updated) {
      // Never leave an unreferenced file behind a failed save.
      await client.storage.from(PRODUCT_IMAGE_BUCKET).remove([path]);
      return actionFailed(
        'UPLOAD_FAILED',
        'The image was uploaded but could not be attached. Try again.',
      );
    }

    if (product.image_path && product.image_path !== path) {
      await client.storage.from(PRODUCT_IMAGE_BUCKET).remove([product.image_path]);
    }

    revalidatePath('/products');
    revalidatePath(`/products/${productId}`);
    return actionOk({ path });
  } catch (error) {
    return toActionResult(error);
  }
}

/** Removes a product's image: the product first, then the file. */
export async function removeProductImage(
  input: unknown,
): Promise<ActionResult<{ productId: string }>> {
  try {
    const { productId } = z.object({ productId: z.uuid() }).parse(input);
    const { auth, client, product, allowed } = await loadProduct(productId);
    if (!allowed)
      return actionFailed('PERMISSION_DENIED', 'You do not have permission to change products.');
    if (!product || !client) return actionFailed('NOT_FOUND', 'That product does not exist.');
    if (!product.image_path) return actionOk({ productId });

    const { error } = await client
      .from('products')
      .update({ image_path: null })
      .eq('tenant_id', auth.tenant.tenantId)
      .eq('id', productId);
    if (error) throw error;
    await client.storage.from(PRODUCT_IMAGE_BUCKET).remove([product.image_path]);

    revalidatePath('/products');
    revalidatePath(`/products/${productId}`);
    return actionOk({ productId });
  } catch (error) {
    return toActionResult(error);
  }
}
