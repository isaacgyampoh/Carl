/**
 * The till.
 *
 * ## The rule this screen exists to honour
 *
 * A sale is written to the local queue *before* anything tells the cashier it succeeded,
 * and before a receipt prints. Money changes hands at the moment the cashier says so; if
 * Carl acknowledges a sale it has not yet written down, a crash in that window takes a
 * transaction that really happened out of existence.
 *
 * So the order is: write, then confirm, then sync whenever the network allows. The engine
 * that does the syncing is `@carl/sync`'s, shared with the web PWA and tested against both
 * queue implementations.
 *
 * ## Totals
 *
 * Every figure on this screen comes from `@carl/domain`'s cart, the same code the web
 * application uses, and the server prices the sale again from its own catalogue when it
 * arrives. The till's total is what the customer is told; the server's is what is
 * recorded, and a database test asserts the two agree to the last pesewa.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EMPTY_CART,
  addToCart,
  cartTotals,
  clearCart,
  removeFromCart,
  toSalePayload,
  updateQuantity,
  type Cart,
  type TaxMode,
} from '@carl/domain';
import { systemClock } from '@carl/shared';
import { SyncEngine, SyncState } from '@carl/sync';

import type { Runtime } from '../app';
import { DeviceSyncTransport } from '../lib/sync-transport';
import type { CatalogueItem } from '../lib/catalogue-store';
import type { DeviceConfig } from '../lib/device-store';
import { PaymentPanel } from './payment-panel';
import { StatusBar } from './status-bar';

const money = (minor: number, currency = 'GHS'): string =>
  new Intl.NumberFormat('en-GH', { style: 'currency', currency }).format(minor / 100);

export function Terminal({
  runtime,
  config,
  secret,
}: {
  runtime: Runtime;
  config: DeviceConfig;
  secret: string;
}): React.JSX.Element {
  const [cart, setCart] = useState<Cart>(EMPTY_CART);
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<CatalogueItem[]>([]);
  const [paying, setPaying] = useState(false);
  const [pending, setPending] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const searchBox = useRef<HTMLInputElement>(null);

  const totals = useMemo(() => cartTotals(cart), [cart]);

  const engine = useMemo(
    () =>
      new SyncEngine({
        queue: runtime.queue,
        transport: new DeviceSyncTransport(runtime.api, {
          deviceId: config.deviceId,
          deviceSecret: secret,
        }),
        clock: systemClock,
      }),
    [runtime, config.deviceId, secret],
  );

  const refreshPending = useCallback(async () => {
    const counts = await runtime.queue.counts();
    setPending((counts[SyncState.PENDING] ?? 0) + (counts[SyncState.FAILED] ?? 0));
  }, [runtime.queue]);

  /**
   * Sync runs on a timer and never blocks the till.
   *
   * A cashier must never wait for the network to finish a sale — that is the entire point
   * of the local queue. Failures here are silent by design; the status bar shows what has
   * not gone through, and the sale is already safe.
   */
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        await engine.run();
      } catch {
        // Already recorded against the operation. Nothing here should surface an alert.
      }
      if (!cancelled) await refreshPending();
    };
    void run();
    const timer = setInterval(() => void run(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [engine, refreshPending]);

  // Search as the cashier types. A scanner types too — very fast, then Enter — which is
  // why the Enter handler tries a barcode before falling back to the first result.
  useEffect(() => {
    let live = true;
    if (term.trim().length === 0) {
      setResults([]);
      return;
    }
    void runtime.catalogue.search(term).then((found) => {
      if (live) setResults(found);
    });
    return () => {
      live = false;
    };
  }, [term, runtime.catalogue]);

  const add = useCallback((item: CatalogueItem, quantity = 1) => {
    const price = item.price;
    if (price === null) {
      // Refused rather than sold at zero. A product with no price is a configuration
      // mistake, and letting it through the till turns that into free stock.
      setNotice(`${item.name} has no price. It cannot be sold until one is set.`);
      return;
    }
    setCart((current) =>
      addToCart(current, {
        productId: item.id,
        name: item.name,
        sku: item.sku,
        unit: item.unit,
        unitPrice: price,
        // Thousandths, matching the domain's integer quantity representation.
        quantity: Math.round(quantity * 1000),
        taxMode: item.taxMode as TaxMode,
        taxRate: item.taxRate,
        allowFractional: item.allowFractional,
        // Null for a service or anything not stock-tracked: there is no quantity to run
        // out of, and a zero would have the cashier warned about stock that does not apply.
        available: item.isStockTracked ? Math.round(item.stock * 1000) : null,
      }),
    );
    setTerm('');
    searchBox.current?.focus();
  }, []);

  async function onSearchEnter(): Promise<void> {
    const scanned = await runtime.catalogue.scan(term);
    if (scanned) {
      // Scanning a case of 24 adds 24, not 1.
      add(scanned.item, scanned.packSize);
      return;
    }
    if (results[0]) add(results[0]);
  }

  return (
    <div style={{ height: '100vh', display: 'grid', gridTemplateRows: 'auto 1fr' }}>
      <StatusBar config={config} pendingCount={pending} onSync={() => void engine.run()} />

      <main style={{ display: 'grid', gridTemplateColumns: '1fr 420px', minHeight: 0 }}>
        <section style={{ padding: 16, display: 'grid', gridTemplateRows: 'auto 1fr', minHeight: 0 }}>
          <input
            ref={searchBox}
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void onSearchEnter();
              }
            }}
            placeholder="Scan a barcode, or search by name or SKU"
            aria-label="Scan or search"
            autoFocus
            spellCheck={false}
          />

          <div style={{ overflowY: 'auto', marginTop: 12 }}>
            {results.map((item) => (
              <button
                key={item.id}
                onClick={() => add(item)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  gap: 12,
                  width: '100%',
                  textAlign: 'left',
                  marginBottom: 8,
                  padding: '12px 14px',
                  minHeight: 56,
                }}
              >
                <span>
                  <strong style={{ display: 'block' }}>{item.name}</strong>
                  <small style={{ color: 'var(--muted)' }}>
                    {item.sku}
                    {item.isStockTracked ? ` · ${item.stock} ${item.unit} in stock` : ''}
                    {/* Labelled as of a time, because a stock figure of unknown age
                        presented as current is worse than one openly stale. */}
                    {item.isStockTracked && item.stockAsOf
                      ? ` (as of ${new Date(item.stockAsOf).toLocaleString()})`
                      : ''}
                  </small>
                </span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {item.price === null ? 'No price' : money(item.price, config.currencyCode)}
                </span>
              </button>
            ))}
          </div>
        </section>

        <aside
          style={{
            background: 'var(--surface)',
            borderLeft: '1px solid var(--border)',
            display: 'grid',
            gridTemplateRows: '1fr auto',
            minHeight: 0,
          }}
        >
          <div style={{ overflowY: 'auto', padding: 16 }}>
            {cart.lines.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>No items yet.</p>
            ) : (
              cart.lines.map((line) => (
                <div
                  key={line.productId}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto auto',
                    alignItems: 'center',
                    gap: 10,
                    marginBottom: 10,
                  }}
                >
                  <span>
                    <strong style={{ display: 'block' }}>{line.name}</strong>
                    <small style={{ color: 'var(--muted)' }}>
                      {line.quantity / 1000} × {money(line.unitPrice, config.currencyCode)}
                    </small>
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={line.quantity / 1000}
                    onChange={(event) =>
                      setCart((current) =>
                        updateQuantity(
                          current,
                          line.productId,
                          Math.round(Number(event.target.value) * 1000),
                        ),
                      )
                    }
                    aria-label={`Quantity for ${line.name}`}
                    style={{ width: 84, textAlign: 'right' }}
                  />
                  <button
                    onClick={() => setCart((current) => removeFromCart(current, line.productId))}
                    aria-label={`Remove ${line.name}`}
                    style={{ minWidth: 44 }}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>

          <div style={{ borderTop: '1px solid var(--border)', padding: 16, display: 'grid', gap: 12 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 30,
                fontWeight: 700,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              <span>Total</span>
              <span>{money(totals.total, config.currencyCode)}</span>
            </div>
            <button
              className="primary"
              disabled={cart.lines.length === 0}
              onClick={() => setPaying(true)}
              style={{ minHeight: 60, fontSize: 19 }}
            >
              Take payment
            </button>
          </div>
        </aside>
      </main>

      {notice ? (
        <div
          role="alert"
          onClick={() => setNotice(null)}
          style={{
            position: 'fixed',
            bottom: 20,
            left: 20,
            background: 'var(--warning)',
            color: '#241a00',
            padding: '12px 16px',
            borderRadius: 10,
            maxWidth: 420,
            cursor: 'pointer',
          }}
        >
          {notice}
        </div>
      ) : null}

      {paying ? (
        <PaymentPanel
          runtime={runtime}
          config={config}
          total={totals.total}
          payload={toSalePayload(cart)}
          onCancel={() => setPaying(false)}
          onCompleted={async () => {
            setPaying(false);
            setCart((current) => clearCart(current));
            await refreshPending();
            // Attempt it straight away, but never wait for it.
            void engine.run().catch(() => undefined);
            searchBox.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
