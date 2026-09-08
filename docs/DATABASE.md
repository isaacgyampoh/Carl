# Database

Carl's database is not a persistence detail. It enforces tenant isolation, guarantees
atomicity for every operation that moves money or stock, and holds invariants that survive
a bug in the application, a support script, or a direct `psql` session.

**47 tables · 150 indexes · 102 check constraints · 30 triggers · 27 enum types**

## Principles

**Constraints are part of the security model.** Application validation can be bypassed. A
`CHECK` cannot. Where a rule can be expressed in the schema, it is.

**Money is `bigint` in minor units.** `GH₵12.50` is `1250`. Never `numeric`, never a float.
See [ARCHITECTURE.md](ARCHITECTURE.md#money-is-an-integer-count-of-minor-units).

**Quantity is `numeric(14,3)`.** Products are sold by weight, so quantity is not an integer;
three decimal places matches `@carl/shared`'s internal representation exactly.

**Financial history is append-only.** The inventory ledger, the audit log, cash movements and
subscription payments all refuse `UPDATE` and `DELETE` by trigger. Corrections are posted as
opposing entries, as in double-entry bookkeeping.

**Extension objects are always schema-qualified** (`extensions.citext`, `extensions.digest`).
The `extensions` schema is on the search path for Supabase's API roles but not during
migration execution — an unqualified reference works on a developer's machine and fails on a
clean database.

## Schemas

| Schema       | Contents                                   | Exposed over the API |
| ------------ | ------------------------------------------ | -------------------- |
| `public`     | Every application table                    | Yes                  |
| `app`        | Helper functions, domains, shared triggers | **No**               |
| `extensions` | `pgcrypto`, `pg_trgm`, `citext`            | No                   |
| `auth`       | Supabase-managed identity                  | No                   |

`app` is deliberately absent from `config.toml`'s exposed schema list. The functions RLS
policies call must be evaluable by the planner but must not be callable, inspectable or
probeable by a client.

## Domains

| Domain            | Underlying type | Enforces                              |
| ----------------- | --------------- | ------------------------------------- |
| `app.money_minor` | `bigint`        | Within ±10¹² minor units              |
| `app.quantity`    | `numeric(14,3)` | Three decimal places                  |
| `app.percentage`  | `numeric(5,2)`  | 0–100                                 |
| `app.label`       | `text`          | Non-blank after trimming, ≤ 200 chars |
| `app.slug`        | `text`          | `^[a-z0-9][a-z0-9_-]{0,62}$`          |

A domain applies its check to every column that uses it, so the rule cannot be forgotten on
the twentieth table that stores an amount. `app.label` in particular rejects `'   '` — which
passes `NOT NULL` but is not a name.

## Migrations

| File                                 | Contents                                                  |
| ------------------------------------ | --------------------------------------------------------- |
| `…000000_extensions_and_conventions` | Schemas, extensions, domains, shared triggers             |
| `…000100_identity_and_tenancy`       | `profiles`, `tenants`, `branches`, memberships            |
| `…000200_roles_and_permissions`      | `permissions`, `roles`, grants, cross-tenant guards       |
| `…000300_devices`                    | Terminals, activation codes, device sessions              |
| `…000400_catalogue`                  | Categories, products, barcodes, windowed prices           |
| `…000500_inventory`                  | Ledger, stock levels, transfers, stock counts             |
| `…000600_sales`                      | Customers, sales, items, payments, returns                |
| `…000700_purchasing_expenses_cash`   | Suppliers, purchases, expenses, cash sessions             |
| `…000800_audit_idempotency_sync`     | Audit log, idempotency keys, sync conflicts               |
| `…000900_platform`                   | Subscriptions, installations, maintenance, support grants |
| `…001000_seed_permissions`           | **Generated** from `@carl/domain`                         |

Migrations are applied in lexical order, which is why every filename starts with a timestamp.
A test asserts this ordering and that every migration applies to a clean database.

## Design notes

### Products are tenant-wide; stock is branch-specific

"Coca-Cola 500ml" is one product for the business, not three because there are three branches.
Duplicating the definition per branch would mean applying a price change three times, stitching
copies back together in reports, and making a barcode scan ambiguous.

So `products` is tenant-scoped and `inventory` is keyed on `(branch_id, product_id)`. A sale in
Accra cannot touch Kumasi's stock — structurally, not by convention.

### Inventory is a ledger, not a counter

`stock = stock - 1` answers "how many are there" and nothing else. When the count is wrong —
and in retail it eventually is — there is no way to find out when or why.

`inventory_movements` is an append-only ledger recording every change with its cause.
`inventory.quantity` is a cached running total so the till can check stock in one indexed read.
A database test asserts the identity `inventory.quantity = sum(inventory_movements.quantity)`,
so the redundancy cannot drift unnoticed.

Each movement also stores `balance_after`, making "what was stock on 3 March" answerable
without replaying history.

A `CHECK` ties direction to movement type: a `SALE` must be negative, a `SALE_RETURN` positive.
An inverted sign is the most damaging inventory bug there is, because it is invisible until
stock-take.

### Prices are windowed

Each price has `effective_from` / `effective_to`. Changing a price closes the old row and opens
a new one. A refund three months later can then be valued at the price actually charged, rather
than today's.

`product_prices` is the **only** source of a selling price. The client sends a product and a
quantity; the server determines the cost. A price in a request body is not validated — it is
ignored.

### Sales store their totals

Totals are written, not computed on read. A receipt must show what was actually charged
forever, even after prices change, tax rates change, or a product is deleted. `sale_items` also
copies `product_name` and `product_sku` at sale time, so a reprinted receipt shows what the
customer bought rather than a later rename.

`cost_total` is captured at sale time for the same reason: historical margin must not move when
a product's cost is updated.

A `CHECK` asserts `total = subtotal - discount_amount + tax_amount` **in the row itself**, so
even a bad migration cannot produce a sale whose parts do not add up.

### Cross-tenant reference guards

Foreign keys guarantee a referenced row _exists_, not that it belongs to the same tenant.
Without further protection, a membership in tenant A could be granted a role belonging to
tenant B: every individual foreign key is satisfied, and the result is a complete authorization
bypass.

RLS does not catch this either — it filters rows rather than validating relationships between
them. Triggers on `membership_roles`, `membership_branches` and `devices` reject cross-tenant
references with `CROSS_TENANT_REFERENCE`. Three database tests assert it.

### Uniqueness is scoped per tenant

Branch codes, SKUs, barcodes and receipt numbers are unique _within a tenant_, never globally.
Two businesses may both have an `ACCRA` branch and a `RICE-5KG` SKU. Global uniqueness would
leak the existence of other tenants through collision errors, and would make one shop's receipt
numbering depend on another's trading volume.

### Partial unique indexes enforce "only one of these"

Used where application logic would race:

| Index                                     | Guarantees                                   |
| ----------------------------------------- | -------------------------------------------- |
| `branches_one_default_per_tenant`         | One default branch                           |
| `tenant_memberships_one_owner_per_tenant` | One owner                                    |
| `product_prices_live_*`                   | One live price per product/tier/branch/break |
| `cash_sessions_one_open_per_register`     | One open drawer session                      |
| `stock_counts_one_open_per_branch`        | One stock take in progress                   |
| `device_activations_one_live_per_device`  | One usable activation code                   |
| `subscriptions_one_live_per_tenant`       | One live subscription                        |
| `idempotency_keys_scope_key`              | One result per operation key                 |

### Idempotency is enforced by an index, not by application logic

A check-then-insert leaves a race between two concurrent retries. The unique index on
`(tenant_id, operation, key)` means both attempt the insert, exactly one succeeds, and the
other is told the operation already exists.

### Offline conflicts are recorded, never resolved silently

Two terminals go offline holding 10 units; one sells 8, the other sells 7. Both are legitimate
from the terminal's point of view. Carl must not pretend 15 units existed, and must not discard
the second sale — the customer took the goods and paid.

`sync_conflicts` stores the transaction verbatim and raises it for a human to decide.

### Support access is not implied by platform admin

`profiles.is_platform_admin` grants access to platform tables — tenants, subscriptions,
devices, installations. It does **not** grant access to a customer's sales, stock or customers.

That requires a row in `tenant_support_grants`: named grantee, stated reason, linked
maintenance ticket, read-only by default, and bounded to seven days by a `CHECK`. A customer
can therefore be told exactly when their data was accessed and why.

## Indexing

Indexes are added where a query pattern justifies one, not on every column.

**Partial indexes** keep hot indexes small — `inventory_low_stock_idx` covers only rows at or
below their reorder level; `tenant_memberships_active_user_idx` only `ACTIVE` membership.

**Trigram GIN indexes** on `products.name`, `products.sku` and `customers.name` power POS
search. `LIKE 'coca%'` cannot match "Coca-Cola" from "cola" and does not survive the typos a
cashier makes under queue pressure.

**Composite ordering** matches how reports read: `(branch_id, sold_at desc)` serves "this
branch's sales, newest first" directly.

Query plans are inspected in Phase 14 against seeded volume; indexes added before there is data
to measure are guesses.

## Testing

```bash
pnpm test:db
```

Runs against real PostgreSQL in-process — no Docker. See [TESTING.md](TESTING.md).
