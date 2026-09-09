'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { customerSchema, type CustomerFormValues, type CustomerInput } from '@carl/validation';
import { formatMoney, parseMoney } from '@carl/shared';
import { Button, Card, CardHeader } from '@carl/ui';

import { createCustomer, updateCustomer } from '@/server/catalogue-actions';
import {
  FormError,
  FormRow,
  FormSection,
  LabelledField,
  inputClass,
  textareaClass,
} from '@/components/form';

/**
 * Creating and editing a customer.
 *
 * The tenant is never a field here. It comes from the verified session on the server, so
 * there is nothing in this form that could place a customer in another business.
 */
export function CustomerForm({
  customerId,
  initial,
}: {
  customerId?: string;
  initial?: Partial<CustomerFormValues>;
}) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<CustomerFormValues, unknown, CustomerInput>({
    resolver: zodResolver(customerSchema),
    defaultValues: { name: '', defaultTier: 'RETAIL', creditLimit: 0, ...initial },
  });

  async function onSubmit(values: CustomerInput): Promise<void> {
    setServerError(null);
    const result = customerId
      ? await updateCustomer({ customerId, patch: values })
      : await createCustomer(values);

    if (!result.ok) {
      setServerError(result.message);
      return;
    }
    router.push('/customers');
    router.refresh();
  }

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} noValidate>
      <Card>
        <CardHeader title={customerId ? 'Edit customer' : 'New customer'} />
        <FormError message={serverError} />

        <FormSection title="Details">
          <FormRow wide>
            <LabelledField label="Name" htmlFor="name" required error={errors.name}>
              <input
                id="name"
                className={inputClass}
                aria-invalid={errors.name ? true : undefined}
                autoFocus
                {...register('name')}
              />
            </LabelledField>
          </FormRow>

          <LabelledField
            label="Phone"
            htmlFor="phone"
            error={errors.phone}
            hint="How a cashier looks this customer up at the till."
          >
            <input id="phone" inputMode="tel" className={inputClass} {...register('phone')} />
          </LabelledField>

          <LabelledField label="Email" htmlFor="email" error={errors.email}>
            <input id="email" type="email" className={inputClass} {...register('email')} />
          </LabelledField>

          <FormRow wide>
            <LabelledField label="Address" htmlFor="address" error={errors.address}>
              <input id="address" className={inputClass} {...register('address')} />
            </LabelledField>
          </FormRow>

          <FormRow wide>
            <LabelledField label="Notes" htmlFor="notes" error={errors.notes}>
              <textarea id="notes" className={textareaClass} {...register('notes')} />
            </LabelledField>
          </FormRow>
        </FormSection>

        <FormSection title="Trading">
          <LabelledField
            label="Price tier"
            htmlFor="defaultTier"
            error={errors.defaultTier}
            hint="A wholesale customer is priced at wholesale automatically."
          >
            <select id="defaultTier" className={inputClass} {...register('defaultTier')}>
              <option value="RETAIL">Retail</option>
              <option value="WHOLESALE">Wholesale</option>
            </select>
          </LabelledField>

          <LabelledField
            label="Credit limit"
            htmlFor="creditLimit"
            error={errors.creditLimit}
            hint="In cedis. Leave at zero for cash-only customers."
          >
            <input
              id="creditLimit"
              inputMode="decimal"
              className={`${inputClass} tabular-nums`}
              defaultValue={
                initial?.creditLimit
                  ? formatMoney(initial.creditLimit, 'GHS', { withSymbol: false })
                  : ''
              }
              onBlur={(event) => {
                const text = event.target.value.trim();
                try {
                  setValue('creditLimit', text === '' ? 0 : parseMoney(text), {
                    shouldValidate: true,
                  });
                } catch {
                  setValue('creditLimit', Number.NaN, { shouldValidate: true });
                }
              }}
            />
          </LabelledField>
        </FormSection>

        <div className="flex justify-end gap-2 px-5 py-4">
          <Button
            type="button"
            variant="secondary"
            onClick={() => router.back()}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button type="submit" loading={isSubmitting}>
            {customerId ? 'Save changes' : 'Create customer'}
          </Button>
        </div>
      </Card>
    </form>
  );
}
