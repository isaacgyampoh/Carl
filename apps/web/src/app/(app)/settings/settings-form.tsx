'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { Alert, Button, Card, CardBody, CardHeader, Field } from '@carl/ui';

import { inputClass } from '@/components/form';
import { formText } from '@/lib/form-data';
import { saveBusinessSettings } from '@/server/settings-actions';

export interface BusinessSettings {
  name: string;
  legalName: string;
  contactPerson: string;
  email: string;
  phone: string;
  address: string;
  timezone: string;
  receiptFooter: string;
  taxRegistrationNo: string;
  defaultTaxRate: number;
  pricesIncludeTax: boolean;
}

/**
 * A business's own details: what appears on receipts, how tax is applied, and its local
 * time. The address, plan and billing are the platform owner's and are not editable here.
 */
export function SettingsForm({ initial }: { initial: BusinessSettings }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const zones = useMemo(() => Intl.supportedValuesOf('timeZone'), []);

  return (
    <form
      className="max-w-3xl space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setMessage(null);
        startTransition(async () => {
          const result = await saveBusinessSettings({
            name: formText(data, 'name'),
            legalName: formText(data, 'legalName'),
            contactPerson: formText(data, 'contactPerson'),
            email: formText(data, 'email'),
            phone: formText(data, 'phone'),
            address: formText(data, 'address'),
            timezone: formText(data, 'timezone'),
            receiptFooter: formText(data, 'receiptFooter'),
            taxRegistrationNo: formText(data, 'taxRegistrationNo'),
            defaultTaxRate: Number(formText(data, 'defaultTaxRate') || '0'),
            pricesIncludeTax: data.get('pricesIncludeTax') === 'on',
          });
          if (!result.ok) {
            setMessage({
              text: result.fieldErrors
                ? (Object.values(result.fieldErrors)[0] ?? result.message)
                : result.message,
              ok: false,
            });
            return;
          }
          setMessage({ text: 'Settings saved.', ok: true });
          router.refresh();
        });
      }}
    >
      {message && <Alert tone={message.ok ? 'positive' : 'danger'}>{message.text}</Alert>}

      <Card>
        <CardHeader title="Business" description="How your business appears to customers." />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="Business name" name="name" required defaultValue={initial.name} />
          <Field label="Legal name" name="legalName" defaultValue={initial.legalName} />
          <Field label="Contact person" name="contactPerson" defaultValue={initial.contactPerson} />
          <Field label="Phone" name="phone" type="tel" defaultValue={initial.phone} />
          <Field label="Email" name="email" type="email" defaultValue={initial.email} />
          <Field label="Address" name="address" defaultValue={initial.address} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Receipts and tax" />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Receipt footer"
            name="receiptFooter"
            hint="Printed at the bottom of every receipt."
            defaultValue={initial.receiptFooter}
          />
          <Field
            label="Tax registration number"
            name="taxRegistrationNo"
            defaultValue={initial.taxRegistrationNo}
          />
          <Field
            label="Default tax rate (%)"
            name="defaultTaxRate"
            type="number"
            min={0}
            max={100}
            step="0.01"
            defaultValue={String(initial.defaultTaxRate)}
          />
          <label className="flex min-h-11 items-center gap-2 self-end pb-2 text-sm">
            <input
              type="checkbox"
              className="size-5 shrink-0 accent-[color:var(--color-brand)]"
              name="pricesIncludeTax"
              defaultChecked={initial.pricesIncludeTax}
            />
            Prices already include tax
          </label>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Local time"
          description="Decides where each day's sales begin and end in reports."
        />
        <CardBody>
          <select name="timezone" defaultValue={initial.timezone} className={inputClass}>
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </CardBody>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" loading={pending}>
          Save settings
        </Button>
      </div>
    </form>
  );
}
