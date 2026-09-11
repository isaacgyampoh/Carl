'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { productSchema, type ProductFormValues, type ProductInput } from '@carl/validation';
import { formatMoney, parseMoney } from '@carl/shared';
import { Button, Card, CardHeader } from '@carl/ui';

import { saveProduct } from '@/server/catalogue-actions';
import {
  FormError,
  FormRow,
  FormSection,
  LabelledField,
  inputClass,
  textareaClass,
} from '@/components/form';

interface Category {
  id: string;
  name: string;
}

/**
 * Creating and editing a product.
 *
 * ## Money in this form
 *
 * Prices are typed as ordinary decimals ("6.50") and converted to integer minor units
 * before they leave the browser. The form never holds a float that could drift — the text
 * is parsed once, at the boundary, by the same `parseMoney` the till uses.
 *
 * ## What the server does anyway
 *
 * Everything here is re-validated by `upsert_product`, which derives the tenant from the
 * branch, checks `products.create` or `products.update`, and writes the product and its
 * prices in one transaction. This form is for the person filling it in; it is not what
 * makes the operation safe.
 */
export function ProductForm({
  branchId,
  categories,
  productId,
  initial,
}: {
  branchId: string;
  categories: Category[];
  productId?: string;
  initial?: Partial<ProductFormValues>;
}) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
    // Three generics: the values the form holds, the resolver context, and the validated
    // output handed to onSubmit. Fields with a Zod default are optional before validation
    // and present after, so collapsing these to one type would need a cast.
  } = useForm<ProductFormValues, unknown, ProductInput>({
    resolver: zodResolver(productSchema),
    defaultValues: {
      name: '',
      sku: '',
      unit: 'unit',
      allowFractional: false,
      isStockTracked: true,
      isActive: true,
      retailPrice: 0,
      costPrice: 0,
      reorderLevel: 0,
      minStock: 0,
      taxMode: 'INCLUSIVE',
      taxRate: 15,
      ...initial,
    },
  });

  const taxMode = watch('taxMode');

  // Read directly rather than through the product schema: opening stock is not an attribute
  // of the product, it is the first entry in its stock ledger.
  const openingStockRef = useRef<HTMLInputElement>(null);

  async function onSubmit(values: ProductInput): Promise<void> {
    setServerError(null);
    const openingStock = Number(openingStockRef.current?.value ?? 0);
    const result = await saveProduct({
      branchId,
      ...(productId ? { productId } : {}),
      product: values,
      ...(!productId && openingStock > 0 ? { openingStock } : {}),
    });

    if (!result.ok) {
      setServerError(result.message);
      return;
    }
    // The product exists either way; if its stock was not recorded, go where it can be.
    router.push(result.data.stockWarning ? `/products/${result.data.productId}` : '/products');
    router.refresh();
  }

  /** Money inputs are text, converted at the boundary rather than held as floats. */
  const moneyField = (field: 'retailPrice' | 'wholesalePrice' | 'costPrice') => ({
    defaultValue:
      initial?.[field] !== undefined
        ? formatMoney(initial[field], 'GHS', { withSymbol: false })
        : '',
    onBlur: (event: React.FocusEvent<HTMLInputElement>) => {
      const text = event.target.value.trim();
      if (text === '') {
        setValue(field, field === 'wholesalePrice' ? undefined : 0, { shouldValidate: true });
        return;
      }
      try {
        setValue(field, parseMoney(text), { shouldValidate: true });
        event.target.value = formatMoney(parseMoney(text), 'GHS', { withSymbol: false });
      } catch {
        setValue(field, Number.NaN, { shouldValidate: true });
      }
    },
  });

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} noValidate>
      <Card>
        <CardHeader
          title={productId ? 'Edit product' : 'New product'}
          description="Products are shared across every branch. Stock is counted per branch."
        />

        <FormError message={serverError} />

        <FormSection title="Identity">
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
            label="SKU"
            htmlFor="sku"
            required
            error={errors.sku}
            hint="Unique within your business. Uppercased automatically."
          >
            <input
              id="sku"
              className={inputClass}
              aria-invalid={errors.sku ? true : undefined}
              {...register('sku')}
            />
          </LabelledField>

          <LabelledField label="Category" htmlFor="categoryId" error={errors.categoryId}>
            <select id="categoryId" className={inputClass} {...register('categoryId')}>
              <option value="">No category</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </LabelledField>

          <LabelledField
            label="Barcode"
            htmlFor="barcode"
            error={errors.barcode}
            hint="Scan into this field to capture it exactly."
          >
            <input
              id="barcode"
              className={inputClass}
              autoComplete="off"
              {...register('barcode')}
            />
          </LabelledField>

          <LabelledField
            label="Unit"
            htmlFor="unit"
            error={errors.unit}
            hint="bottle, bag, kg, crate…"
          >
            <input id="unit" className={inputClass} {...register('unit')} />
          </LabelledField>

          <FormRow wide>
            <LabelledField label="Description" htmlFor="description" error={errors.description}>
              <textarea id="description" className={textareaClass} {...register('description')} />
            </LabelledField>
          </FormRow>
        </FormSection>

        <FormSection
          title="Pricing"
          description="What the customer pays. The till always uses these; a price is never taken from the browser at checkout."
        >
          <LabelledField
            label="Retail price"
            htmlFor="retailPrice"
            required
            error={errors.retailPrice}
            hint="In cedis, e.g. 6.50"
          >
            <input
              id="retailPrice"
              inputMode="decimal"
              className={`${inputClass} tabular-nums`}
              aria-invalid={errors.retailPrice ? true : undefined}
              {...moneyField('retailPrice')}
            />
          </LabelledField>

          <LabelledField
            label="Wholesale price"
            htmlFor="wholesalePrice"
            error={errors.wholesalePrice}
            hint="Optional. Used for customers on the wholesale tier."
          >
            <input
              id="wholesalePrice"
              inputMode="decimal"
              className={`${inputClass} tabular-nums`}
              {...moneyField('wholesalePrice')}
            />
          </LabelledField>

          <LabelledField
            label="Cost price"
            htmlFor="costPrice"
            error={errors.costPrice}
            hint="The starting cost. Once you receive a purchase, this becomes a weighted average and is maintained for you."
          >
            <input
              id="costPrice"
              inputMode="decimal"
              className={`${inputClass} tabular-nums`}
              {...moneyField('costPrice')}
            />
          </LabelledField>
        </FormSection>

        <FormSection title="Image">
          <LabelledField
            label="Image URL"
            htmlFor="imageUrl"
            error={errors.imageUrl}
            hint="Optional. A link to a picture of the product."
          >
            <input
              id="imageUrl"
              type="url"
              inputMode="url"
              autoComplete="off"
              className={inputClass}
              {...register('imageUrl', {
                setValueAs: (value: string) => (value === '' ? null : value),
              })}
            />
          </LabelledField>
        </FormSection>

        <FormSection title="Tax">
          <LabelledField label="Tax treatment" htmlFor="taxMode" error={errors.taxMode}>
            <select id="taxMode" className={inputClass} {...register('taxMode')}>
              <option value="INCLUSIVE">Price includes tax</option>
              <option value="EXCLUSIVE">Tax added at the till</option>
              <option value="EXEMPT">Exempt</option>
            </select>
          </LabelledField>

          {taxMode !== 'EXEMPT' && (
            <LabelledField label="Tax rate (%)" htmlFor="taxRate" error={errors.taxRate} required>
              <input
                id="taxRate"
                type="number"
                step="0.01"
                min="0"
                max="100"
                className={`${inputClass} tabular-nums`}
                aria-invalid={errors.taxRate ? true : undefined}
                {...register('taxRate', { valueAsNumber: true })}
              />
            </LabelledField>
          )}
        </FormSection>

        <FormSection title="Stock">
          {!productId && (
            <LabelledField
              label="Opening stock"
              htmlFor="openingStock"
              hint="How many you have right now at this branch. Stock can be adjusted later."
            >
              <input
                id="openingStock"
                ref={openingStockRef}
                type="number"
                step="any"
                min="0"
                defaultValue=""
                className={`${inputClass} tabular-nums`}
              />
            </LabelledField>
          )}

          <LabelledField
            label="Reorder level"
            htmlFor="reorderLevel"
            error={errors.reorderLevel}
            hint="Appears in the low-stock list at or below this."
          >
            <input
              id="reorderLevel"
              type="number"
              step="any"
              min="0"
              className={`${inputClass} tabular-nums`}
              {...register('reorderLevel', { valueAsNumber: true })}
            />
          </LabelledField>

          <LabelledField label="Minimum stock" htmlFor="minStock" error={errors.minStock}>
            <input
              id="minStock"
              type="number"
              step="any"
              min="0"
              className={`${inputClass} tabular-nums`}
              {...register('minStock', { valueAsNumber: true })}
            />
          </LabelledField>

          <FormRow wide>
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" {...register('isStockTracked')} />
                Track stock for this product
                <span className="text-[color:var(--color-ink-muted)]">
                  — turn off for services, which never run out
                </span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" {...register('allowFractional')} />
                Can be sold in fractions
                <span className="text-[color:var(--color-ink-muted)]">
                  — for goods sold by weight or length
                </span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" {...register('isActive')} />
                Available for sale
              </label>
            </div>
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
            {productId ? 'Save changes' : 'Create product'}
          </Button>
        </div>
      </Card>
    </form>
  );
}
