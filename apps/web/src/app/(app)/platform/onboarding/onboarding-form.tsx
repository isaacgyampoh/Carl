'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from '@carl/validation';
import { Alert, Field, buttonClasses } from '@carl/ui';
import { Currency, formatMoney } from '@carl/shared';

import { onboardClient, type OnboardedClient } from '@/server/platform-actions';

export interface PlanOption {
  id: string;
  key: string;
  name: string;
  price: number;
  interval: string;
  currency_code: string;
  max_branches: number | null;
  max_devices: number | null;
}

/**
 * The form mirrors the server action's schema rather than restating it loosely: a field
 * the server would reject should be rejected here too, so the operator finds out before
 * a business is half-typed rather than after they press the button.
 */
const schema = z.object({
  businessName: z.string().trim().min(2, 'The business needs a name.').max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, 'Lowercase letters, numbers and hyphens.'),
  ownerName: z.string().trim().min(2, "The owner's name is required.").max(120),
  ownerEmail: z.email('A valid email is required — the owner signs in with it.'),
  planId: z.uuid('Choose a plan.'),
  branchName: z.string().trim().min(2).max(80).default('Main Branch'),
  branchCode: z.string().trim().min(1).max(20).default('main'),
  contactPerson: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  address: z.string().trim().max(300).optional(),
  trialDays: z.coerce.number().int().min(0).max(365).default(14),
  graceDays: z.coerce.number().int().min(0).max(90).default(7),
  notes: z.string().trim().max(1000).optional(),
});

type FormValues = z.input<typeof schema>;
type FormOutput = z.output<typeof schema>;

export function OnboardingForm({ plans }: { plans: PlanOption[] }) {
  const [result, setResult] = useState<OnboardedClient | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const form = useForm<FormValues, unknown, FormOutput>({
    resolver: zodResolver(schema),
    defaultValues: {
      branchName: 'Main Branch',
      branchCode: 'main',
      trialDays: 14,
      graceDays: 7,
      planId: plans[0]?.id ?? '',
    },
  });

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = form;

  const plan = plans.find((p) => p.id === watch('planId'));

  async function submit(values: FormOutput) {
    setFailure(null);
    const outcome = await onboardClient(values);
    if (outcome.ok) setResult(outcome.data);
    else setFailure(outcome.message);
  }

  if (result) {
    return (
      <div className="space-y-4 p-4">
        <Alert tone="positive" title="Client onboarded">
          The business, its first branch, the owner&apos;s login and the subscription were all
          created.
        </Alert>
        <dl className="grid gap-3 sm:grid-cols-2">
          {[
            ['Business', watch('businessName')],
            ['Client ID', result.tenantId],
            ['Branch', watch('branchName')],
            ['Status', result.status.replace('_', ' ')],
            ['Onboarded', new Date().toLocaleDateString('en-GB')],
            ['Next billing', new Date(result.nextBillingAt).toLocaleDateString('en-GB')],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-sm text-[color:var(--color-text-muted)]">{label}</dt>
              <dd className="break-words font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        <Alert tone="info" title="Next: set up their first terminal">
          Issue an activation code from the client&apos;s page, then enter it on the terminal. The
          owner signs in with {watch('ownerEmail')} using a password reset.
        </Alert>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/platform/clients/${result.tenantId}`}
            className={buttonClasses({ variant: 'primary' })}
          >
            Open client
          </Link>
          <Link href="/platform/onboarding" className={buttonClasses({ variant: 'secondary' })}>
            Add another
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => void handleSubmit(submit)(event)}
      className="space-y-6 p-4"
      noValidate
    >
      {failure && (
        <Alert tone="danger" title="Could not onboard this client">
          {failure}
        </Alert>
      )}

      <fieldset className="space-y-4">
        <legend className="text-sm font-medium">Business</legend>
        <Field label="Business name" error={errors.businessName?.message}>
          <input
            {...register('businessName', {
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                // Suggested, not forced: the slug is part of the URL a merchant sees, and
                // the operator can overwrite it before submitting.
                if (!form.formState.dirtyFields.slug) {
                  setValue(
                    'slug',
                    event.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, '-')
                      .replace(/^-+|-+$/g, '')
                      .slice(0, 50),
                  );
                }
              },
            })}
            className={inputClass}
            autoComplete="organization"
          />
        </Field>
        <Field label="Identifier" error={errors.slug?.message} hint="Used in links. Lowercase.">
          <input {...register('slug')} className={inputClass} />
        </Field>
        <Field label="Contact person" error={errors.contactPerson?.message}>
          <input {...register('contactPerson')} className={inputClass} autoComplete="name" />
        </Field>
        <Field label="Phone" error={errors.phone?.message}>
          <input {...register('phone')} className={inputClass} inputMode="tel" autoComplete="tel" />
        </Field>
        <Field label="Address" error={errors.address?.message}>
          <input {...register('address')} className={inputClass} />
        </Field>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-sm font-medium">Owner</legend>
        <Field label="Owner name" error={errors.ownerName?.message}>
          <input {...register('ownerName')} className={inputClass} autoComplete="name" />
        </Field>
        <Field
          label="Owner email"
          error={errors.ownerEmail?.message}
          hint="They sign in with this."
        >
          <input
            {...register('ownerEmail')}
            type="email"
            inputMode="email"
            className={inputClass}
            autoComplete="email"
          />
        </Field>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-sm font-medium">First branch</legend>
        <Field label="Branch name" error={errors.branchName?.message}>
          <input {...register('branchName')} className={inputClass} />
        </Field>
        <Field label="Branch code" error={errors.branchCode?.message} hint="Appears on receipts.">
          <input {...register('branchCode')} className={inputClass} />
        </Field>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-sm font-medium">Subscription</legend>
        <Field label="Plan" error={errors.planId?.message}>
          <select {...register('planId')} className={inputClass}>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {formatMoney(p.price, (p.currency_code as Currency) ?? Currency.GHS)} /{' '}
                {p.interval.toLowerCase()}
              </option>
            ))}
          </select>
        </Field>
        {plan && (
          <p className="text-sm text-[color:var(--color-text-muted)]">
            {plan.max_branches ? `Up to ${plan.max_branches} branches` : 'Unlimited branches'} ·{' '}
            {plan.max_devices ? `${plan.max_devices} terminals` : 'Unlimited terminals'}
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Trial days"
            error={errors.trialDays?.message}
            hint="0 to start billing now."
          >
            <input
              {...register('trialDays')}
              type="number"
              inputMode="numeric"
              min={0}
              max={365}
              className={inputClass}
            />
          </Field>
          <Field label="Grace days" error={errors.graceDays?.message} hint="After the due date.">
            <input
              {...register('graceDays')}
              type="number"
              inputMode="numeric"
              min={0}
              max={90}
              className={inputClass}
            />
          </Field>
        </div>
        <Field label="Notes" error={errors.notes?.message}>
          <textarea {...register('notes')} rows={3} className={`${inputClass} h-auto py-2`} />
        </Field>
      </fieldset>

      <button
        type="submit"
        disabled={isSubmitting}
        className={buttonClasses({ variant: 'primary', className: 'w-full sm:w-auto' })}
      >
        {isSubmitting ? 'Creating…' : 'Onboard client'}
      </button>
    </form>
  );
}

const inputClass =
  'h-11 w-full rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 outline-none focus-visible:outline-2 focus-visible:outline-[color:var(--color-brand)]';
