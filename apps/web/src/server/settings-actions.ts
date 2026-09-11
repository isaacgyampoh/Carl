'use server';

import { revalidatePath } from 'next/cache';
import { hasPermission } from '@carl/application';
import { Permission } from '@carl/domain';
import { ErrorCode } from '@carl/shared';
import { z } from '@carl/validation';

import { currentAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { actionFailed, actionOk, toActionResult, type ActionResult } from './errors';

const optionalText = (max: number) => z.string().trim().max(max).optional();

const settingsSchema = z.object({
  name: z.string().trim().min(2, 'The business needs a name.').max(120),
  legalName: optionalText(160),
  contactPerson: optionalText(120),
  email: z.union([z.email('That email address is not valid.'), z.literal('')]).optional(),
  phone: optionalText(40),
  address: optionalText(300),
  timezone: z.string().trim().max(64),
  receiptFooter: optionalText(500),
  taxRegistrationNo: optionalText(60),
  defaultTaxRate: z.number().min(0).max(100),
  pricesIncludeTax: z.boolean(),
});

/**
 * Saves a business's own details.
 *
 * ## Only these columns, by construction
 *
 * The patch is built field by field below, never by spreading the input. The database
 * enforces the same boundary independently: migration 0038 grants `authenticated` UPDATE on
 * exactly these columns of `tenants`, so a request that also tried to set the slug, status,
 * currency or trial dates is refused by PostgreSQL — those belong to the platform owner.
 */
export async function saveBusinessSettings(input: unknown): Promise<ActionResult<{ saved: true }>> {
  try {
    const parsed = settingsSchema.parse(input);
    const auth = await currentAuth();
    if (!auth?.tenant) return actionFailed(ErrorCode.UNAUTHENTICATED, 'Sign in first.');
    if (!hasPermission(auth, Permission.SETTINGS_MANAGE)) {
      return actionFailed(
        ErrorCode.PERMISSION_DENIED,
        'You do not have permission to change settings.',
      );
    }
    // An unknown zone would silently shift every "today" figure in reports.
    if (!Intl.supportedValuesOf('timeZone').includes(parsed.timezone)) {
      return actionFailed(ErrorCode.VALIDATION_FAILED, 'Choose a timezone from the list.');
    }

    const blank = (value: string | undefined) => (value && value.length > 0 ? value : null);
    const client = await supabase();
    const { data, error } = await client
      .from('tenants')
      .update({
        name: parsed.name,
        legal_name: blank(parsed.legalName),
        contact_person: blank(parsed.contactPerson),
        email: blank(parsed.email),
        phone: blank(parsed.phone),
        address: blank(parsed.address),
        timezone: parsed.timezone,
        receipt_footer: blank(parsed.receiptFooter),
        tax_registration_no: blank(parsed.taxRegistrationNo),
        default_tax_rate: parsed.defaultTaxRate,
        prices_include_tax: parsed.pricesIncludeTax,
      })
      .eq('id', auth.tenant.tenantId)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    // RLS filters an unauthorised update to zero rows rather than raising.
    if (!data)
      return actionFailed(ErrorCode.PERMISSION_DENIED, 'These settings could not be saved.');

    revalidatePath('/settings');
    revalidatePath('/dashboard');
    return actionOk({ saved: true });
  } catch (error) {
    return toActionResult(error);
  }
}
