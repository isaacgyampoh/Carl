import 'server-only';

import { requirePlatformAdmin } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

/**
 * Reads for the platform console.
 *
 * All of these run as the signed-in platform administrator, under RLS. None uses the
 * service role, so a bug here cannot read further than the policies allow — and the
 * policies deliberately stop short of any merchant's business data.
 *
 * Each function issues a bounded number of queries regardless of how many clients exist.
 * The console is one page; it must not become one query per row.
 */

export type ClientStatus = 'TRIAL' | 'ACTIVE' | 'GRACE_PERIOD' | 'SUSPENDED' | 'CANCELLED';

export interface ClientRow {
  tenantId: string;
  name: string;
  slug: string;
  status: ClientStatus;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  onboardedAt: string;
  currencyCode: string;
  planName: string | null;
  price: number | null;
  interval: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  nextBillingAt: string | null;
  graceDays: number;
  branchCount: number;
  deviceCount: number;
}

/** Where a client sits commercially — derived from dates, not stored. */
export type BillingState =
  'TRIAL' | 'CURRENT' | 'DUE_SOON' | 'DUE' | 'GRACE' | 'OVERDUE' | 'INACTIVE';

/**
 * Derives billing state from the subscription's own period and grace.
 *
 * Kept in one function because it is the definition of "who owes money", and a second
 * copy of it on a dashboard would eventually disagree with the billing page.
 */
export function billingState(client: ClientRow, now = new Date()): BillingState {
  if (client.status === 'SUSPENDED' || client.status === 'CANCELLED') return 'INACTIVE';
  if (!client.nextBillingAt) return client.status === 'TRIAL' ? 'TRIAL' : 'CURRENT';

  const due = new Date(client.nextBillingAt);
  const graceEnds = new Date(due.getTime() + client.graceDays * 86_400_000);
  const days = Math.ceil((due.getTime() - now.getTime()) / 86_400_000);

  if (now > graceEnds) return 'OVERDUE';
  if (now > due) return 'GRACE';
  if (days <= 0) return 'DUE';
  if (days <= 7) return 'DUE_SOON';
  return client.status === 'TRIAL' ? 'TRIAL' : 'CURRENT';
}

export function daysUntil(iso: string | null, now = new Date()): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - now.getTime()) / 86_400_000);
}

interface ListOptions {
  search?: string;
  status?: ClientStatus | 'ALL';
  sort?: 'newest' | 'oldest' | 'due' | 'name';
  limit?: number;
}

/**
 * The client list.
 *
 * Four queries total: the tenants page, then their subscriptions, branch counts and device
 * counts fetched in one round trip each and joined in memory. The alternative — a
 * subquery per row — is the N+1 that makes an operations console unusable at 200 clients.
 */
export async function listClients(options: ListOptions = {}): Promise<ClientRow[]> {
  await requirePlatformAdmin();
  const client = await supabase();
  const limit = options.limit ?? 200;

  let query = client
    .from('tenants')
    .select('id, name, slug, status, contact_person, phone, email, created_at, currency_code')
    .limit(limit);

  if (options.status && options.status !== 'ALL') query = query.eq('status', options.status);
  if (options.search?.trim()) {
    // Searched server-side. Pulling every tenant into the browser to filter would leak the
    // whole customer list to anything watching the response.
    const term = `%${options.search.trim()}%`;
    query = query.or(
      `name.ilike.${term},slug.ilike.${term},contact_person.ilike.${term},phone.ilike.${term},email.ilike.${term}`,
    );
  }

  switch (options.sort) {
    case 'oldest':
      query = query.order('created_at', { ascending: true });
      break;
    case 'name':
      query = query.order('name', { ascending: true });
      break;
    // 'due' is ordered after the subscriptions are joined, below; the database cannot sort
    // tenants by a column that lives on another table without a view.
    case 'due':
    case 'newest':
    case undefined:
      query = query.order('created_at', { ascending: false });
      break;
  }

  const { data: tenants, error } = await query;
  if (error) throw error;
  if (!tenants?.length) return [];

  const ids = tenants.map((t) => t.id);

  const [subs, branches, devices] = await Promise.all([
    client
      .from('subscriptions')
      .select(
        'id, tenant_id, status, price, interval, current_period_end, grace_days, subscription_plans(name)',
      )
      .in('tenant_id', ids),
    client.from('branches').select('id, tenant_id').in('tenant_id', ids),
    client.from('devices').select('id, tenant_id, status').in('tenant_id', ids),
  ]);

  type SubscriptionRow = NonNullable<typeof subs.data>[number];
  const subByTenant = new Map<string, SubscriptionRow>();
  for (const s of subs.data ?? []) subByTenant.set(s.tenant_id, s);
  const countBy = <T extends { tenant_id: string }>(rows: T[] | null) => {
    const map = new Map<string, number>();
    for (const r of rows ?? []) map.set(r.tenant_id, (map.get(r.tenant_id) ?? 0) + 1);
    return map;
  };
  const branchCount = countBy(branches.data);
  const deviceCount = countBy((devices.data ?? []).filter((d) => d.status === 'ACTIVE'));

  const rows: ClientRow[] = tenants.map((t) => {
    const sub = subByTenant.get(t.id);
    const plan = sub?.subscription_plans as { name?: string } | null | undefined;
    return {
      tenantId: t.id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      contactPerson: t.contact_person,
      phone: t.phone,
      email: t.email,
      onboardedAt: t.created_at,
      currencyCode: t.currency_code,
      planName: plan?.name ?? null,
      price: sub?.price ?? null,
      interval: sub?.interval ?? null,
      subscriptionId: sub?.id ?? null,
      subscriptionStatus: sub?.status ?? null,
      nextBillingAt: sub?.current_period_end ?? null,
      graceDays: sub?.grace_days ?? 7,
      branchCount: branchCount.get(t.id) ?? 0,
      deviceCount: deviceCount.get(t.id) ?? 0,
    };
  });

  if (options.sort === 'due') {
    // Nulls last: a client with no subscription is not "due first".
    rows.sort((a, b) => {
      if (!a.nextBillingAt) return 1;
      if (!b.nextBillingAt) return -1;
      return a.nextBillingAt.localeCompare(b.nextBillingAt);
    });
  }
  return rows;
}

export interface PlatformOverview {
  total: number;
  active: number;
  trial: number;
  grace: number;
  suspended: number;
  dueSoon: number;
  overdue: number;
  branches: number;
  activeDevices: number;
  pendingActivations: number;
  expectedThisMonth: number;
  currencyCode: string;
}

export async function platformOverview(): Promise<{
  overview: PlatformOverview;
  recent: ClientRow[];
}> {
  const clients = await listClients({ limit: 500 });
  const client = await supabase();

  const [{ count: branches }, { count: activeDevices }, { count: pending }] = await Promise.all([
    client.from('branches').select('id', { count: 'exact', head: true }),
    client.from('devices').select('id', { count: 'exact', head: true }).eq('status', 'ACTIVE'),
    client
      .from('device_activations')
      .select('id', { count: 'exact', head: true })
      .is('consumed_at', null),
  ]);

  const states = clients.map((c) => billingState(c));
  const monthEnd = new Date();
  monthEnd.setMonth(monthEnd.getMonth() + 1, 0);

  return {
    overview: {
      total: clients.length,
      active: clients.filter((c) => c.status === 'ACTIVE').length,
      trial: clients.filter((c) => c.status === 'TRIAL').length,
      grace: clients.filter((c) => c.status === 'GRACE_PERIOD').length,
      suspended: clients.filter((c) => c.status === 'SUSPENDED').length,
      dueSoon: states.filter((s) => s === 'DUE_SOON' || s === 'DUE').length,
      overdue: states.filter((s) => s === 'OVERDUE' || s === 'GRACE').length,
      branches: branches ?? 0,
      activeDevices: activeDevices ?? 0,
      pendingActivations: pending ?? 0,
      // What should be collected between now and month end, if everyone pays on time.
      expectedThisMonth: clients
        .filter((c) => c.nextBillingAt && new Date(c.nextBillingAt) <= monthEnd)
        .reduce((sum, c) => sum + (c.price ?? 0), 0),
      currencyCode: clients[0]?.currencyCode ?? 'GHS',
    },
    recent: clients.slice(0, 6),
  };
}

/**
 * Cross-client operational reads.
 *
 * These exist because the client profile answers "how is this business doing" and the
 * platform owner also needs "which invoices are unpaid across everyone" — a question no
 * per-client page can answer. Each is one query plus one lookup, never one per row.
 */

export interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  tenantId: string;
  tenantName: string;
  amount: number;
  currencyCode: string;
  status: string;
  issuedAt: string | null;
  dueAt: string;
  paidAt: string | null;
  periodStart: string;
  periodEnd: string;
}

export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'PAID' | 'OVERDUE' | 'CANCELLED';

export async function listInvoices(status?: InvoiceStatus | 'ALL'): Promise<InvoiceRow[]> {
  await requirePlatformAdmin();
  const client = await supabase();

  let query = client
    .from('subscription_invoices')
    .select(
      'id, invoice_number, tenant_id, amount, currency_code, status, issued_at, due_at, paid_at, period_start, period_end, tenants(name)',
    )
    .order('created_at', { ascending: false })
    .limit(200);
  if (status && status !== 'ALL') query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw error;

  return (data ?? []).map((i) => ({
    id: i.id,
    invoiceNumber: i.invoice_number,
    tenantId: i.tenant_id,
    tenantName: (i.tenants as { name?: string } | null)?.name ?? 'Unknown',
    amount: i.amount,
    currencyCode: i.currency_code,
    status: i.status,
    issuedAt: i.issued_at,
    dueAt: i.due_at,
    paidAt: i.paid_at,
    periodStart: i.period_start,
    periodEnd: i.period_end,
  }));
}

export interface DeviceRow {
  id: string;
  name: string;
  code: string;
  status: string;
  tenantId: string;
  tenantName: string;
  branchName: string;
  activatedAt: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
  pendingActivation: boolean;
}

export type DeviceStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';

export async function listDevices(status?: DeviceStatus | 'ALL'): Promise<DeviceRow[]> {
  await requirePlatformAdmin();
  const client = await supabase();

  let query = client
    .from('devices')
    .select(
      'id, name, code, status, tenant_id, branch_id, activated_at, last_seen_at, revoked_at, tenants(name), branches(name)',
    )
    .order('created_at', { ascending: false })
    .limit(300);
  if (status && status !== 'ALL') query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw error;

  const ids = (data ?? []).map((d) => d.id);
  // One query for every outstanding activation, rather than one per terminal.
  const { data: pending } = ids.length
    ? await client
        .from('device_activations')
        .select('device_id')
        .in('device_id', ids)
        .is('consumed_at', null)
    : { data: [] };
  const awaiting = new Set((pending ?? []).map((p) => p.device_id));

  return (data ?? []).map((d) => ({
    id: d.id,
    name: d.name,
    code: d.code,
    status: d.status,
    tenantId: d.tenant_id,
    tenantName: (d.tenants as { name?: string } | null)?.name ?? 'Unknown',
    branchName: (d.branches as { name?: string } | null)?.name ?? '—',
    activatedAt: d.activated_at,
    lastSeenAt: d.last_seen_at,
    revokedAt: d.revoked_at,
    pendingActivation: awaiting.has(d.id),
  }));
}

export interface AuditRow {
  id: string;
  action: string;
  tenantId: string | null;
  tenantName: string;
  actorName: string;
  occurredAt: string;
  metadata: Record<string, unknown>;
}

/**
 * Platform activity.
 *
 * The RLS policy already restricts a platform administrator to platform-operated actions —
 * a merchant's own trading history is not readable here and needs a support grant. This
 * query does not widen that; it reads what the policy allows.
 */
export async function listPlatformAudit(limit = 100): Promise<AuditRow[]> {
  await requirePlatformAdmin();
  const client = await supabase();

  const { data, error } = await client
    .from('audit_logs')
    .select('id, action, tenant_id, actor_name, actor_email, occurred_at, metadata, tenants(name)')
    .order('occurred_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data ?? []).map((a) => ({
    id: a.id,
    action: a.action,
    tenantId: a.tenant_id,
    tenantName: (a.tenants as { name?: string } | null)?.name ?? '—',
    actorName: a.actor_name ?? a.actor_email ?? 'System',
    occurredAt: a.occurred_at,
    metadata: (a.metadata ?? {}) as Record<string, unknown>,
  }));
}
