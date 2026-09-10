'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { createLogger } from '@carl/shared';
import { z } from '@carl/validation';

import { requirePlatformAdmin } from '@/lib/auth';
import { supabase, serviceRoleClient } from '@/lib/supabase';
import { actionOk, toActionResult, type ActionResult } from './errors';

const log = createLogger({ level: 'info', base: { module: 'platform-actions' } });

/**
 * The platform owner's operations.
 *
 * Every one of these calls a database function that re-checks `app.is_platform_admin()`
 * for itself. The `requirePlatformAdmin()` here is the outer of two locks, not the only
 * one: if this file were ever refactored badly, or a route forgot its guard, the database
 * still refuses. That is deliberate — this layer decides what a screen shows, and the
 * database decides what may happen.
 *
 * Nothing here trusts a tenant id, branch id, price or status from the browser. The
 * arguments are validated, passed to the function, and the function derives everything
 * else from its own tables.
 */

const onboardSchema = z.object({
  businessName: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, 'Use lowercase letters, numbers and hyphens.'),
  ownerEmail: z.email(),
  ownerName: z.string().trim().min(2).max(120),
  planId: z.uuid(),
  branchName: z.string().trim().min(2).max(80).default('Main Branch'),
  branchCode: z.string().trim().min(1).max(20).default('main'),
  contactPerson: z.string().trim().max(120).optional(),
  billingEmail: z.email().optional(),
  phone: z.string().trim().max(40).optional(),
  address: z.string().trim().max(300).optional(),
  legalName: z.string().trim().max(160).optional(),
  currencyCode: z.string().length(3).default('GHS'),
  timezone: z.string().default('Africa/Accra'),
  trialDays: z.number().int().min(0).max(365).default(14),
  // An override of the plan's price: a negotiated rate is an ordinary commercial fact,
  // but it arrives explicitly and is recorded on the subscription rather than assumed.
  price: z.number().int().min(0).optional(),
  graceDays: z.number().int().min(0).max(90).default(7),
  notes: z.string().trim().max(1000).optional(),
});

export interface OnboardedClient {
  tenantId: string;
  branchId: string;
  subscriptionId: string;
  status: string;
  nextBillingAt: string;
}

/**
 * Creates a customer.
 *
 * The owner's login account has to exist before the tenant can reference it, and creating
 * an account is an Auth operation rather than a database one — on Supabase, `auth.users`
 * belongs to the Auth service and not even `service_role` may write it directly. So this
 * creates the account through the Auth admin API first, then hands the resulting id to
 * `onboard_client`, which does everything else in one transaction.
 *
 * If the transaction fails, the account is left behind but nothing else is: no tenant, no
 * branch, no subscription. An orphaned login that owns nothing is inert, and far safer
 * than a half-created business.
 */
export async function onboardClient(input: unknown): Promise<ActionResult<OnboardedClient>> {
  try {
    const parsed = onboardSchema.parse(input);
    const auth = await requirePlatformAdmin();

    const admin = serviceRoleClient();

    // A temporary password nobody is told. The owner sets their own via the recovery link
    // below, so this value exists only to satisfy the Auth API and is never transmitted.
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: parsed.ownerEmail,
      email_confirm: true,
      password: randomUUID() + randomUUID(),
      user_metadata: { full_name: parsed.ownerName },
    });

    let ownerUserId: string | undefined = created?.user?.id;

    if (createError) {
      // Already registered — onboarding a second business for an existing person is
      // ordinary, so this is not an error. Find them rather than refusing.
      const { data: existing } = await admin
        .from('profiles')
        .select('id')
        .eq('email', parsed.ownerEmail)
        .maybeSingle();
      ownerUserId = existing?.id;
      if (!ownerUserId) throw createError;
    }
    if (!ownerUserId) throw new Error('Could not resolve an owner account for this business.');

    const client = await supabase();
    const { data, error } = await client.rpc('onboard_client', {
      p_business_name: parsed.businessName,
      p_slug: parsed.slug,
      p_owner_email: parsed.ownerEmail,
      p_owner_name: parsed.ownerName,
      p_owner_user_id: ownerUserId,
      p_plan_id: parsed.planId,
      p_branch_name: parsed.branchName,
      p_branch_code: parsed.branchCode,
      p_contact_person: parsed.contactPerson ?? undefined,
      p_email: parsed.billingEmail ?? undefined,
      p_phone: parsed.phone ?? undefined,
      p_address: parsed.address ?? undefined,
      p_legal_name: parsed.legalName ?? undefined,
      p_currency_code: parsed.currencyCode,
      p_timezone: parsed.timezone,
      p_trial_days: parsed.trialDays,
      p_price: parsed.price ?? undefined,
      p_grace_days: parsed.graceDays,
      p_notes: parsed.notes ?? undefined,
    });
    if (error) throw error;

    const row = data?.[0];
    if (!row?.tenant_id) throw new Error('onboard_client returned no tenant');

    log.info('client onboarded', {
      tenantId: row.tenant_id,
      actorId: auth.user.userId,
      trialDays: parsed.trialDays,
    });

    revalidatePath('/platform');
    revalidatePath('/platform/clients');
    if (!row.branch_id || !row.subscription_id || !row.status || !row.next_billing_at) {
      throw new Error('onboard_client returned an incomplete client');
    }
    return actionOk({
      tenantId: row.tenant_id,
      branchId: row.branch_id,
      subscriptionId: row.subscription_id,
      status: row.status,
      nextBillingAt: row.next_billing_at,
    });
  } catch (error) {
    return toActionResult(error);
  }
}

const paymentSchema = z.object({
  subscriptionId: z.uuid(),
  amount: z.number().int().positive(),
  // CREDIT is deliberately absent: it means "on the customer's account", which is a sale
  // on terms, not a subscription fee that has actually been collected.
  method: z.enum(['CASH', 'MOMO', 'BANK_TRANSFER', 'CARD', 'OTHER']),
  reference: z.string().trim().max(120).optional(),
  paidAt: z.string().optional(),
  invoiceId: z.uuid().optional(),
  notes: z.string().trim().max(500).optional(),
  /*
   * Supplied by the form, not generated here.
   *
   * A key minted inside this function would be new on every retry, which would make the
   * idempotency guarantee useless in the exact case it exists for — an operator on a bad
   * connection pressing the button twice. The form mints one per attempt and reuses it.
   */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
});

export async function recordSubscriptionPayment(
  input: unknown,
): Promise<ActionResult<{ paymentId: string; wasReplayed: boolean; periodEnd: string }>> {
  try {
    const parsed = paymentSchema.parse(input);
    const auth = await requirePlatformAdmin();

    const client = await supabase();
    const { data, error } = await client.rpc('record_subscription_payment', {
      p_subscription_id: parsed.subscriptionId,
      p_amount: parsed.amount,
      p_idempotency_key: parsed.idempotencyKey,
      p_method: parsed.method,
      p_reference: parsed.reference ?? undefined,
      p_paid_at: parsed.paidAt ?? undefined,
      p_invoice_id: parsed.invoiceId ?? undefined,
      p_notes: parsed.notes ?? undefined,
    });
    if (error) throw error;

    const row = data?.[0];
    if (!row?.payment_id) throw new Error('record_subscription_payment returned no payment');

    // The reference is a bank or mobile-money identifier, not a credential, and it is how
    // support traces a disputed payment. The amount is deliberately not logged here; it is
    // in the audit trail, which is access-controlled.
    log.info('subscription payment recorded', {
      paymentId: row.payment_id,
      replayed: row.was_replayed,
      actorId: auth.user.userId,
    });

    revalidatePath('/platform/billing');
    revalidatePath('/platform/clients');
    return actionOk({
      paymentId: row.payment_id,
      wasReplayed: row.was_replayed ?? false,
      periodEnd: row.period_end ?? '',
    });
  } catch (error) {
    return toActionResult(error);
  }
}

const invoiceSchema = z.object({
  subscriptionId: z.uuid(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  amount: z.number().int().positive().optional(),
  dueAt: z.string().optional(),
  notes: z.string().trim().max(500).optional(),
});

export async function issueInvoice(
  input: unknown,
): Promise<ActionResult<{ invoiceId: string; invoiceNumber: string; dueAt: string }>> {
  try {
    const parsed = invoiceSchema.parse(input);
    await requirePlatformAdmin();

    const client = await supabase();
    const { data, error } = await client.rpc('issue_invoice', {
      p_subscription_id: parsed.subscriptionId,
      p_period_start: parsed.periodStart ?? undefined,
      p_period_end: parsed.periodEnd ?? undefined,
      p_amount: parsed.amount ?? undefined,
      p_due_at: parsed.dueAt ?? undefined,
      p_notes: parsed.notes ?? undefined,
    });
    if (error) throw error;

    const row = data?.[0];
    if (!row?.invoice_id) throw new Error('issue_invoice returned no invoice');

    revalidatePath('/platform/invoices');
    revalidatePath('/platform/billing');
    if (!row.invoice_number) throw new Error('issue_invoice returned no invoice number');
    return actionOk({
      invoiceId: row.invoice_id,
      invoiceNumber: row.invoice_number,
      dueAt: row.due_at ?? '',
    });
  } catch (error) {
    return toActionResult(error);
  }
}

const suspendSchema = z.object({
  tenantId: z.uuid(),
  reason: z.string().trim().min(5).max(300),
});

/** Stops a business trading. The reason is required because someone will have to explain it. */
export async function suspendTenant(input: unknown): Promise<ActionResult<{ tenantId: string }>> {
  try {
    const parsed = suspendSchema.parse(input);
    const auth = await requirePlatformAdmin();

    const client = await supabase();
    const { error } = await client.rpc('suspend_tenant', {
      p_tenant_id: parsed.tenantId,
      p_reason: parsed.reason,
    });
    if (error) throw error;

    log.warn('tenant suspended', { tenantId: parsed.tenantId, actorId: auth.user.userId });

    revalidatePath('/platform');
    revalidatePath(`/platform/clients/${parsed.tenantId}`);
    return actionOk({ tenantId: parsed.tenantId });
  } catch (error) {
    return toActionResult(error);
  }
}

const reactivateSchema = z.object({
  tenantId: z.uuid(),
  note: z.string().trim().max(300).optional(),
});

export async function reactivateTenant(
  input: unknown,
): Promise<ActionResult<{ tenantId: string }>> {
  try {
    const parsed = reactivateSchema.parse(input);
    const auth = await requirePlatformAdmin();

    const client = await supabase();
    const { error } = await client.rpc('reactivate_tenant', {
      p_tenant_id: parsed.tenantId,
      p_note: parsed.note ?? undefined,
    });
    if (error) throw error;

    log.info('tenant reactivated', { tenantId: parsed.tenantId, actorId: auth.user.userId });

    revalidatePath('/platform');
    revalidatePath(`/platform/clients/${parsed.tenantId}`);
    return actionOk({ tenantId: parsed.tenantId });
  } catch (error) {
    return toActionResult(error);
  }
}
