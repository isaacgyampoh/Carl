'use client';

import { useState } from 'react';
import { formatMoney, formatQuantity, parseMoney } from '@carl/shared';
import { Button, Table, TBody, TD, TH, THead, TR } from '@carl/ui';

import { inputClass } from './form';

export interface ProductOption {
  id: string;
  name: string;
  sku: string;
  unit: string;
  /** Current cost, offered as the default when buying. */
  averageCost: number;
  /** Stock at the source branch, shown when moving goods out. */
  available?: number;
}

export interface BuilderLine {
  productId: string;
  name: string;
  sku: string;
  unit: string;
  quantity: number;
  /** Only used where the workflow involves money — purchases, not transfers. */
  unitCost?: number;
}

/**
 * Building a list of products and quantities.
 *
 * Shared by purchases and transfers because the interaction is identical: find a product,
 * say how many, adjust, remove. The difference is only whether a cost is involved, which
 * is a prop rather than a second component.
 *
 * A product already on the list is merged rather than duplicated — two lines for the same
 * product is something the person has to notice and reconcile, and the database would
 * reject it anyway on the unique (transfer, product) index.
 */
export function LineItemBuilder({
  products,
  lines,
  onChange,
  withCost,
  showAvailable,
}: {
  products: ProductOption[];
  lines: BuilderLine[];
  onChange: (lines: BuilderLine[]) => void;
  withCost?: boolean;
  showAvailable?: boolean;
}) {
  const [search, setSearch] = useState('');
  const chosen = new Set(lines.map((line) => line.productId));

  const matches =
    search.trim().length === 0
      ? []
      : products
          .filter(
            (product) =>
              !chosen.has(product.id) &&
              (product.name.toLowerCase().includes(search.toLowerCase()) ||
                product.sku.toLowerCase().includes(search.toLowerCase())),
          )
          .slice(0, 8);

  function add(product: ProductOption) {
    onChange([
      ...lines,
      {
        productId: product.id,
        name: product.name,
        sku: product.sku,
        unit: product.unit,
        quantity: 1,
        ...(withCost ? { unitCost: product.averageCost } : {}),
      },
    ]);
    setSearch('');
  }

  function update(productId: string, patch: Partial<BuilderLine>) {
    onChange(lines.map((line) => (line.productId === productId ? { ...line, ...patch } : line)));
  }

  const total = lines.reduce(
    (sum, line) => sum + Math.round(line.quantity * (line.unitCost ?? 0)),
    0,
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search a product by name or SKU"
          aria-label="Search products to add"
          className={inputClass}
          autoComplete="off"
        />
        {matches.length > 0 && (
          <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] shadow-lg">
            {matches.map((product) => (
              <li key={product.id}>
                <button
                  type="button"
                  onClick={() => add(product)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-[color:var(--color-surface-muted)]"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{product.name}</span>
                    <span className="block text-xs text-[color:var(--color-ink-muted)]">
                      {product.sku}
                    </span>
                  </span>
                  {showAvailable && (
                    <span className="shrink-0 text-xs tabular-nums text-[color:var(--color-ink-muted)]">
                      {formatQuantity(Math.round((product.available ?? 0) * 1000))} in stock
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {lines.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[color:var(--color-border)] px-4 py-8 text-center text-sm text-[color:var(--color-ink-muted)]">
          No products added yet.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[color:var(--color-border)]">
          <Table>
            <THead>
              <TR>
                <TH>Product</TH>
                <TH numeric>Quantity</TH>
                {withCost && <TH numeric>Unit cost</TH>}
                {withCost && <TH numeric>Line total</TH>}
                <TH />
              </TR>
            </THead>
            <TBody>
              {lines.map((line) => (
                <TR key={line.productId}>
                  <TD>
                    <span className="font-medium">{line.name}</span>
                    <span className="block text-xs text-[color:var(--color-ink-muted)]">
                      {line.sku}
                    </span>
                  </TD>
                  <TD numeric>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={line.quantity}
                      onChange={(event) =>
                        update(line.productId, { quantity: Number(event.target.value) })
                      }
                      aria-label={`Quantity of ${line.name}`}
                      className="h-9 w-24 rounded-md border border-[color:var(--color-border)] px-2 text-right tabular-nums"
                    />
                  </TD>
                  {withCost && (
                    <TD numeric>
                      <input
                        inputMode="decimal"
                        defaultValue={formatMoney(line.unitCost ?? 0, 'GHS', { withSymbol: false })}
                        onBlur={(event) => {
                          try {
                            update(line.productId, { unitCost: parseMoney(event.target.value) });
                          } catch {
                            // Leave the previous value rather than writing NaN into the
                            // line; the field shows what the user typed and the submit
                            // validation reports it.
                          }
                        }}
                        aria-label={`Unit cost of ${line.name}`}
                        className="h-9 w-28 rounded-md border border-[color:var(--color-border)] px-2 text-right tabular-nums"
                      />
                    </TD>
                  )}
                  {withCost && (
                    <TD numeric>{formatMoney(Math.round(line.quantity * (line.unitCost ?? 0)))}</TD>
                  )}
                  <TD>
                    <button
                      type="button"
                      onClick={() => onChange(lines.filter((l) => l.productId !== line.productId))}
                      aria-label={`Remove ${line.name}`}
                      className="text-sm text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-danger)]"
                    >
                      Remove
                    </button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {withCost && (
            <div className="flex justify-between border-t border-[color:var(--color-border)] px-4 py-3">
              <span className="text-sm font-medium text-[color:var(--color-ink-muted)]">
                Order total
              </span>
              <span className="text-lg font-semibold tabular-nums">{formatMoney(total)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export { Button };
