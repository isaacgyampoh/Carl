'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type Cart,
  DiscountKind,
  EMPTY_CART,
  addToCart,
  cartTotals,
  clearCart,
  insufficientLines,
  removeFromCart,
  toSalePayload,
  updateQuantity,
} from '@carl/domain';
import { formatMoney, formatQuantity, newIdempotencyKey } from '@carl/shared';
import { Alert, Button } from '@carl/ui';

import { completeSale, searchProducts, type SearchResult } from '@/server/pos-actions';
import { PaymentPanel } from './payment-panel';
import { ReceiptDialog } from './receipt-dialog';

/**
 * The till.
 *
 * ## What this screen optimises for
 *
 * A cashier stands at this for eight hours with a queue in front of them. Every decision
 * here follows from that:
 *
 *   - The search box holds focus permanently. A barcode scanner is a keyboard, so a scan
 *     only works if something is listening; anything that steals focus breaks scanning
 *     silently, and the cashier discovers it mid-transaction.
 *   - The cart total is computed locally and updates on the same frame as the scan. A
 *     round trip per item would make the till feel broken. The server re-derives it at
 *     checkout, and a test asserts the two agree to the pesewa.
 *   - Keyboard shortcuts cover the whole flow, because reaching for a mouse between
 *     every customer costs more than it looks like it does.
 *   - No confirmation dialogs on the hot path. A cashier who has to dismiss something on
 *     every sale stops reading it by the second hour.
 */
export function PosTerminal({
  branchId,
  branchName,
  cashierName,
  canDiscount,
  canSellWholesale,
}: {
  branchId: string;
  branchName: string;
  cashierName: string;
  canDiscount: boolean;
  canSellWholesale: boolean;
}) {
  const [cart, setCart] = useState<Cart>(EMPTY_CART);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [receipt, setReceipt] = useState<{
    saleNumber: string;
    total: number;
    paid: number;
    change: number;
  } | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const totals = cartTotals(cart);
  const short = insufficientLines(cart);

  /**
   * Returns focus to the search box.
   *
   * Called after every action that could have moved it. A scanner types into whatever has
   * focus, so this is what keeps scanning working at all.
   */
  const focusSearch = useCallback(() => {
    searchRef.current?.focus();
    searchRef.current?.select();
  }, []);

  const addProduct = useCallback(
    (result: SearchResult) => {
      setCart((current) =>
        addToCart(current, {
          productId: result.productId,
          name: result.name,
          sku: result.sku,
          unit: result.unit,
          unitPrice: result.unitPrice,
          // A case barcode adds its whole pack, not one unit.
          quantity: Math.round(result.packSize * 1000),
          taxMode: 'EXEMPT',
          taxRate: 0,
          allowFractional: false,
          available: Math.round(result.quantity * 1000),
        }),
      );
      setQuery('');
      setResults([]);
      setError(null);
      focusSearch();
    },
    [focusSearch],
  );

  // Search, debounced. An exact barcode match is added straight to the cart without the
  // cashier choosing from a list — that is the entire point of a scanner.
  useEffect(() => {
    const term = query.trim();
    if (term.length === 0) {
      setResults([]);
      return;
    }

    const timer = setTimeout(() => {
      setSearching(true);
      void searchProducts({ branchId, query: term, tier: cart.tier, limit: 20 })
        .then((result) => {
          if (!result.ok) {
            setError(result.message);
            setResults([]);
            return;
          }
          const exact = result.data.find((r) => r.isExact);
          if (exact) {
            addProduct(exact);
          } else {
            setResults(result.data);
          }
        })
        .finally(() => setSearching(false));
    }, 120);

    return () => clearTimeout(timer);
  }, [query, branchId, cart.tier, addProduct]);

  // Shortcuts. F-keys rather than letter combinations, so they cannot collide with a
  // barcode being typed into the search field.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'F2') {
        event.preventDefault();
        focusSearch();
      } else if (event.key === 'F4' && cart.lines.length > 0) {
        event.preventDefault();
        setPaying(true);
      } else if (event.key === 'Escape') {
        setPaying(false);
        focusSearch();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cart.lines.length, focusSearch]);

  useEffect(focusSearch, [focusSearch]);

  async function onPay(payments: { method: string; amount: number; reference?: string }[]) {
    setError(null);

    // Generated once, here, for this logical sale. Generating it inside a retry loop would
    // provide no protection at all.
    const idempotencyKey = newIdempotencyKey();

    const result = await completeSale({
      branchId,
      ...toSalePayload(cart),
      payments,
      idempotencyKey,
      tier: cart.tier,
      ...(cart.customerId ? { customerId: cart.customerId } : {}),
      ...(cart.orderDiscount.kind !== DiscountKind.NONE
        ? {
            orderDiscount: { type: cart.orderDiscount.kind, value: cart.orderDiscount.value },
          }
        : {}),
    });

    if (!result.ok) {
      setError(result.message);
      setPaying(false);
      return;
    }

    setReceipt({
      saleNumber: result.data.saleNumber,
      total: result.data.total,
      paid: result.data.amountPaid,
      change: result.data.changeGiven,
    });
    setCart((current) => clearCart(current));
    setPaying(false);
  }

  return (
    <div className="flex h-[calc(100dvh-8rem)] flex-col gap-4 lg:h-[calc(100dvh-6.5rem)] lg:flex-row">
      {/* Search and results */}
      <section className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex items-center gap-2">
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Scan a barcode or search by name or SKU"
            aria-label="Scan or search for a product"
            autoComplete="off"
            spellCheck={false}
            className="h-14 flex-1 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-4 text-lg outline-none focus-visible:outline-2 focus-visible:outline-[color:var(--color-brand)]"
          />
          {canSellWholesale && (
            <Button
              variant={cart.tier === 'WHOLESALE' ? 'primary' : 'secondary'}
              size="lg"
              onClick={() => {
                setCart((c) => ({ ...c, tier: c.tier === 'RETAIL' ? 'WHOLESALE' : 'RETAIL' }));
                focusSearch();
              }}
            >
              {cart.tier === 'WHOLESALE' ? 'Wholesale' : 'Retail'}
            </Button>
          )}
        </div>

        {error && <Alert tone="danger">{error}</Alert>}

        <div className="min-h-0 flex-1 overflow-y-auto rounded-[var(--radius-card)] border border-[color:var(--color-border)] bg-[color:var(--color-surface)]">
          {results.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
              <p className="text-sm text-[color:var(--color-ink-muted)]">
                {searching ? 'Searching…' : 'Scan an item, or type to search.'}
              </p>
              <p className="text-xs text-[color:var(--color-ink-muted)]">
                F2 search · F4 pay · Esc cancel
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-[color:var(--color-border)]">
              {results.map((result) => (
                <li key={result.productId}>
                  <button
                    type="button"
                    onClick={() => addProduct(result)}
                    className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-[color:var(--color-surface-muted)]"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{result.name}</span>
                      <span className="block text-xs text-[color:var(--color-ink-muted)]">
                        {result.sku} ·{' '}
                        {result.quantity > 0 ? (
                          `${formatQuantity(Math.round(result.quantity * 1000))} in stock`
                        ) : (
                          <span className="text-[color:var(--color-danger)]">Out of stock</span>
                        )}
                      </span>
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums">
                      {formatMoney(result.unitPrice)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Cart */}
      <section className="flex min-h-0 w-full flex-col rounded-[var(--radius-card)] border border-[color:var(--color-border)] bg-[color:var(--color-surface)] lg:w-[26rem]">
        <header className="flex items-center justify-between border-b border-[color:var(--color-border)] px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{branchName}</p>
            <p className="truncate text-xs text-[color:var(--color-ink-muted)]">{cashierName}</p>
          </div>
          {cart.lines.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setCart(clearCart);
                focusSearch();
              }}
            >
              Clear
            </Button>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {cart.lines.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-[color:var(--color-ink-muted)]">
              The basket is empty.
            </p>
          ) : (
            <ul className="divide-y divide-[color:var(--color-border)]">
              {cart.lines.map((line) => {
                const isShort = short.includes(line);
                return (
                  <li key={line.productId} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{line.name}</p>
                        <p className="text-xs tabular-nums text-[color:var(--color-ink-muted)]">
                          {formatMoney(line.unitPrice)} each
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove ${line.name}`}
                        onClick={() => {
                          setCart((c) => removeFromCart(c, line.productId));
                          focusSearch();
                        }}
                        className="shrink-0 text-sm text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-danger)]"
                      >
                        Remove
                      </button>
                    </div>

                    <div className="mt-2 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-1">
                        {/* Large targets: these are hit with a thumb on a touch panel. */}
                        <Button
                          variant="secondary"
                          size="icon"
                          aria-label={`Reduce ${line.name}`}
                          onClick={() =>
                            setCart((c) => updateQuantity(c, line.productId, line.quantity - 1000))
                          }
                        >
                          −
                        </Button>
                        <span className="min-w-12 text-center text-sm font-semibold tabular-nums">
                          {formatQuantity(line.quantity)}
                        </span>
                        <Button
                          variant="secondary"
                          size="icon"
                          aria-label={`Add another ${line.name}`}
                          onClick={() =>
                            setCart((c) => updateQuantity(c, line.productId, line.quantity + 1000))
                          }
                        >
                          +
                        </Button>
                      </div>
                      <span className="font-semibold tabular-nums">
                        {formatMoney(line.unitPrice * (line.quantity / 1000))}
                      </span>
                    </div>

                    {isShort && (
                      <p className="mt-1.5 text-xs text-[color:var(--color-warning)]">
                        Only {formatQuantity(line.available ?? 0)} in stock at this branch.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="border-t border-[color:var(--color-border)] px-4 py-3">
          {totals.orderDiscount > 0 && (
            <div className="mb-1 flex justify-between text-sm text-[color:var(--color-ink-muted)]">
              <span>Discount</span>
              <span className="tabular-nums">−{formatMoney(totals.orderDiscount)}</span>
            </div>
          )}
          <div className="mb-3 flex items-baseline justify-between">
            <span className="text-sm font-medium text-[color:var(--color-ink-muted)]">Total</span>
            <span className="text-3xl font-semibold tabular-nums tracking-tight">
              {formatMoney(totals.total)}
            </span>
          </div>

          {short.length > 0 && (
            <p className="mb-2 text-xs text-[color:var(--color-warning)]">
              Some items exceed the stock at this branch. The sale will be refused unless the count
              is corrected.
            </p>
          )}

          <Button
            size="pos"
            block
            disabled={cart.lines.length === 0}
            onClick={() => setPaying(true)}
          >
            Pay {formatMoney(totals.total)}
          </Button>
        </footer>
      </section>

      {paying && (
        <PaymentPanel
          total={totals.total}
          canDiscount={canDiscount}
          onCancel={() => {
            setPaying(false);
            focusSearch();
          }}
          onConfirm={onPay}
        />
      )}

      {receipt && (
        <ReceiptDialog
          receipt={receipt}
          branchName={branchName}
          cashierName={cashierName}
          onClose={() => {
            setReceipt(null);
            focusSearch();
          }}
        />
      )}
    </div>
  );
}
