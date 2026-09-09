'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { supplierSchema, type SupplierFormValues, type SupplierInput } from '@carl/validation';
import { Button, Card, CardHeader } from '@carl/ui';

import { createSupplier, updateSupplier } from '@/server/catalogue-actions';
import {
  FormError,
  FormRow,
  FormSection,
  LabelledField,
  inputClass,
  textareaClass,
} from '@/components/form';

export function SupplierForm({
  supplierId,
  initial,
}: {
  supplierId?: string;
  initial?: Partial<SupplierFormValues>;
}) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SupplierFormValues, unknown, SupplierInput>({
    resolver: zodResolver(supplierSchema),
    defaultValues: { name: '', paymentTermsDays: 0, ...initial },
  });

  async function onSubmit(values: SupplierInput): Promise<void> {
    setServerError(null);
    const result = supplierId
      ? await updateSupplier({ supplierId, patch: values })
      : await createSupplier(values);

    if (!result.ok) {
      setServerError(result.message);
      return;
    }
    router.push('/suppliers');
    router.refresh();
  }

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} noValidate>
      <Card>
        <CardHeader title={supplierId ? 'Edit supplier' : 'New supplier'} />
        <FormError message={serverError} />

        <FormSection title="Details">
          <FormRow wide>
            <LabelledField label="Business name" htmlFor="name" required error={errors.name}>
              <input
                id="name"
                className={inputClass}
                aria-invalid={errors.name ? true : undefined}
                autoFocus
                {...register('name')}
              />
            </LabelledField>
          </FormRow>

          <LabelledField label="Contact person" htmlFor="contactName" error={errors.contactName}>
            <input id="contactName" className={inputClass} {...register('contactName')} />
          </LabelledField>

          <LabelledField label="Phone" htmlFor="phone" error={errors.phone}>
            <input id="phone" inputMode="tel" className={inputClass} {...register('phone')} />
          </LabelledField>

          <LabelledField label="Email" htmlFor="email" error={errors.email}>
            <input id="email" type="email" className={inputClass} {...register('email')} />
          </LabelledField>

          <LabelledField
            label="Payment terms (days)"
            htmlFor="paymentTermsDays"
            error={errors.paymentTermsDays}
            hint="Zero means payment on delivery. Drives the payables ageing report."
          >
            <input
              id="paymentTermsDays"
              type="number"
              min="0"
              max="365"
              className={`${inputClass} tabular-nums`}
              {...register('paymentTermsDays', { valueAsNumber: true })}
            />
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
            {supplierId ? 'Save changes' : 'Create supplier'}
          </Button>
        </div>
      </Card>
    </form>
  );
}
