# Security

**102 RLS policies · 50 tables protected · 18 SECURITY DEFINER functions · 57 database security tests**

Carl is a multi-tenant SaaS handling money and stock for competing businesses. If one tenant
can read another's data, nothing else about the product matters. This document describes what
enforces that, and how it is proved.

No claim is made that Carl is unbreakable. The design is defence in depth: several independent
layers, each of which must fail before data is exposed.

---

## Where authorization actually lives

**In PostgreSQL.** Not in React, not in a middleware, not in a server action.

Hiding a button is not access control. A cashier who opens the network tab and replays a
request with a different `tenant_id` meets exactly the same Row Level Security policy the UI
did, and it refuses them.

| Layer                 | Enforces                              | Bypassable by                       |
| --------------------- | ------------------------------------- | ----------------------------------- |
| UI permission checks  | Not showing unusable controls         | Anyone with a browser console       |
| Zod validation        | Shape and range of input              | Anyone calling the API directly     |
| Server actions        | Orchestration                         | A leaked token                      |
| **RLS policies**      | **Tenant, branch and role isolation** | **Nothing reachable by a client**   |
| **CHECK constraints** | **Invariants**                        | **Nothing, including psql**         |
| Immutability triggers | Append-only history                   | Nothing, including the service role |

---

## The tenancy model

```
auth.users                Supabase-managed credentials
    │ 1:1
profiles                  Carl's view of a person
    │ 1:N
tenant_memberships        "works for this business"  (status must be ACTIVE)
    │ 1:N
membership_roles          "holds this role"  (optionally scoped to one branch)
    │
role_permissions          "which permissions that role carries"
```

Every policy resolves through this chain, starting from `auth.uid()` — the subject claim of a
JWT Supabase has already verified.

**No policy reads a client-supplied value.** Not a request body, not a header, not a URL
parameter, not a hidden form field. A caller who edits `tenant_id` in a request changes
nothing, because nothing consults it.

An `rls-coverage` test enforces this mechanically: it scans every policy expression and fails
if one reads a session setting other than the verified JWT claims.

---

## The helper functions

Policies are built on functions in the `app` schema, which is **not exposed over the API**. A
client cannot call, inspect or probe them.

| Function                       | Answers                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `app.current_user_id()`        | Who is calling (from the verified JWT)                                       |
| `app.is_tenant_member(t)`      | Active membership of tenant `t`                                              |
| `app.can_access_branch(b)`     | May act in branch `b`                                                        |
| `app.has_permission(t, p, b)`  | Holds permission `p`, optionally in branch `b`                               |
| `app.tenant_can_transact(t)`   | Tenant is in good standing (may write)                                       |
| `app.can_read(t, p, b)`        | **The read predicate**: membership + permission + branch, or a support grant |
| `app.can_write_tenant(t)`      | Member of a tenant that may transact                                         |
| `app.strongest_role_rank(t)`   | Prevents granting a role above your own                                      |
| `app.has_support_access(t, w)` | A live, time-boxed support grant                                             |
| `app.is_platform_admin()`      | Administers the platform (not tenant data)                                   |

Every one is `STABLE`, `SECURITY DEFINER`, and pinned with `set search_path = ''`.

### Why each of those properties matters

**`SECURITY DEFINER`** lets a helper read membership tables without re-entering the policies
that call it. Without it, a policy on `tenant_memberships` that consults `tenant_memberships`
recurses — PostgreSQL raises 42P17.

**`set search_path = ''`** is the one that would be a vulnerability to omit. A `SECURITY
DEFINER` function runs with its owner's privileges. If it resolved an unqualified name through
the _caller's_ search path, a caller who created their own `public.tenant_memberships` could
make the function read their table and grant themselves any tenant they liked. Every
identifier in every helper is fully qualified.

An `rls-coverage` test queries `pg_proc` and fails the build on any `SECURITY DEFINER` function
in `public` or `app` without a pinned search path.

**`STABLE`, called as `(select app.…)`** is performance, not security — but a policy slow
enough to make the POS unusable gets removed, so it is load-bearing anyway. The scalar
subquery lets PostgreSQL hoist the call into an InitPlan evaluated **once per statement**
rather than once per row.

---

## Reads and writes are separated deliberately

Read policies use `app.can_read(...)`. Write policies additionally require
`app.tenant_can_transact(...)`.

A **suspended** tenant can still read its own records but cannot trade. Withholding a
business's own data because a payment is late is hostile, and for tax records legally fraught.
A tenant in **grace period** trades normally — a payment a few days late must not close the
shop mid-morning.

---

## Every UPDATE policy specifies both USING and WITH CHECK

`USING` decides _which rows_ may be updated. `WITH CHECK` decides _what they may become_.

A policy with only `USING` permits a specific attack: take a row you legitimately own, rewrite
its `tenant_id`, and it lands in someone else's business. Every UPDATE policy in Carl specifies
both, and a test asserts the transfer is refused.

---

## Platform administration is not access to tenant data

This is the boundary most systems get wrong, and it erodes quietly.

A row in `platform_admins` grants the **platform**: tenants, subscriptions, devices,
installations, maintenance. It does **not** grant access to any business's sales, stock,
customers or expenses.

Reading a customer's business data requires a `tenant_support_grants` row:

- names the individual grantee
- states a reason, optionally linked to a maintenance ticket
- **read-only by default** — write access is a separate, deliberate decision
- **expires within seven days**, enforced by a `CHECK`
- **visible to the customer**, who can see exactly who was granted access and why

Nine tests cover this: that an admin with no grant reads nothing; that expired, revoked, and
wrong-tenant grants confer nothing; that a read-only grant cannot write; that a non-admin
cannot use a grant issued to them; and that the customer can see the grant.

### Why `platform_admins` is a table, not a column

It started as `profiles.is_platform_admin` and that was wrong.

A user can update their own profile row. Stopping them from also flipping a privilege column
requires a policy on `profiles` that reads `profiles` — which PostgreSQL rejects outright as
infinite recursion, and which would have broken every legitimate profile update.

Moving the flag out means there is no privilege column on the row a user controls. The only
route left is inserting into `platform_admins`, which has no INSERT policy at all.

**This was found by a test, not by review** — specifically by `expectDenied` refusing to accept
a statement that failed for the wrong reason.

---

## Privilege escalation

| Attack                             | Defence                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------- |
| Grant yourself platform admin      | No privilege column on your own row; `platform_admins` has no INSERT policy |
| Grant yourself a stronger role     | `app.strongest_role_rank()` — you cannot grant above your own rank          |
| Grant yourself a role with no role | Roleless callers rank as the weakest possible and can grant nothing         |
| Use another tenant's role          | Cross-tenant trigger + a same-tenant condition in the policy                |
| Move your row into another tenant  | `WITH CHECK` on every UPDATE policy                                         |
| Add yourself to another tenant     | `WITH CHECK` on `tenant_memberships` INSERT                                 |
| Claim ownership on insert          | `is_owner = false` enforced in the policy                                   |
| Create a system role               | `is_system = false` enforced in the policy                                  |
| Approve your own expense           | `expenses.create` and `expenses.approve` are separate permissions           |
| Set your own price                 | `products.manage_pricing` is separate from `products.update`                |
| Write stock directly               | No INSERT/UPDATE policy on `inventory` for any role                         |
| Rewrite the audit log              | Immutability trigger — refuses even the service role                        |

---

## Key handling

| Credential            | Location                                            | Reaches the client?                   |
| --------------------- | --------------------------------------------------- | ------------------------------------- |
| Supabase anon key     | `NEXT_PUBLIC_SUPABASE_ANON_KEY`                     | **Yes, and that is fine** — see below |
| Service role key      | `SUPABASE_SERVICE_ROLE_KEY`                         | **Never**                             |
| Device secret pepper  | `CARL_DEVICE_SECRET_PEPPER`                         | **Never**                             |
| Device secrets        | Hashed (SHA-256, peppered) in `devices.secret_hash` | Shown once at activation              |
| Activation codes      | Hashed in `device_activations.code_hash`            | Shown once to the installer           |
| Cashier refresh token | The terminal's OS credential store                  | It is the cashier's own               |

The anon key is safe to publish **only because RLS is enforced on every tenant-owned table**.
If RLS were ever disabled on one table, this key would expose it — which is why the coverage
test is a blocking CI gate rather than a nice-to-have.

### A terminal never talks to PostgreSQL

`activate_device`, `sync_offline_sale` and `device_catalogue` all take the pepper as an
argument, and the pepper exists in neither the database nor the terminal. That is what stops
a stolen database dump from yielding working credentials for every till in the estate — so
the pepper has to be applied somewhere that is neither, and that is the application server.

Three routes hold it. A terminal reaches Carl only through them:

| Route                   | Authenticates with                        | Runs as                    |
| ----------------------- | ----------------------------------------- | -------------------------- |
| `/api/device/activate`  | The activation code itself                | Service role — no user yet |
| `/api/device/catalogue` | The device secret                         | Service role — no user     |
| `/api/device/sync`      | The device secret **and** a cashier token | **The cashier**            |

The last row is the one that matters. A sale is attributed to a person, and `complete_sale`
checks that person holds `sales.create` at that branch. Syncing as the service role would
satisfy the database while attributing every offline sale to nobody and skipping every
permission check — which is exactly how a shared till becomes an unaudited one. So a
terminal proves two separate things, and neither is sufficient alone: which till it is, and
who is standing at it.

`bearerClient()` exists for this: a _user_ client, subject to RLS, for callers that carry
their own credential instead of a cookie.

### What a terminal may download

`device_catalogue` returns only what is needed to ring up a sale. It excludes `average_cost`
and `last_cost` — a stolen laptop should not reveal what the business pays its suppliers —
along with customer balances and credit limits, every other branch's stock, and every other
tenant's anything. Those absences are asserted by tests, and the cost-leak detector has been
verified to fail when a leak is planted.

The service-role key **bypasses RLS entirely**. `packages/infrastructure/src/config/server-env.ts`
imports `server-only`, so any module reachable from a client component that imports it fails
the build. That makes leaking it a compile error rather than a code-review convention.

---

## Browser-level defences

Everything above concerns the database. These are the headers the web application sends,
and they matter because a cashier signs in from a shop's own wifi.

| Header                                | Value                              | Why                                                                   |
| ------------------------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `Strict-Transport-Security`           | 2 years, `includeSubDomains`       | Without it the first request of the day is plaintext and downgradable |
| `X-Content-Type-Options`              | `nosniff`                          | Stops an uploaded file being re-interpreted as script                 |
| `X-Frame-Options`                     | `DENY`                             | Clickjacking                                                          |
| `Referrer-Policy`                     | `strict-origin-when-cross-origin`  | A URL can name a tenant; it should not leak off-origin                |
| `Permissions-Policy`                  | microphone and geolocation closed  | Carl needs neither                                                    |
| `Content-Security-Policy`             | **enforcing**, partial — see below | Closes the injection vectors that can be closed without risk          |
| `Content-Security-Policy-Report-Only` | the full policy                    | Measures the one directive that cannot yet be enforced                |

`preload` is deliberately absent from HSTS: getting onto the preload list takes minutes and
getting off it takes months, which is not a commitment to make before a custom domain is
settled.

### Why the CSP is split in two

**Enforced today:** `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
`frame-ancestors 'none'`. Each is enforced because breaking it would require the application
to do something it verifiably does not do — there is no `<object>`, no `<embed>`, no
`<base>`, and every form is a React Server Action, which is same-origin by construction.
`base-uri` in particular is worth more than it looks: an injected `<base>` silently rewrites
every relative URL on the page, including the one the sign-in form posts to.

**Not enforced:** `script-src`. Next.js serves inline bootstrap scripts, so enforcing it
needs either a nonce threaded through every response or `'unsafe-inline'` — and
`'unsafe-inline'` is worse than omitting the directive, because it looks like protection.
That policy stays Report-Only until the collected reports show a strict one would not blank
a till mid-shift.

So the honest summary is: **script execution is measured, not controlled.** That is a real
remaining gap, and it is recorded as PARTIAL rather than as a control that is in place.

Reports go to `/api/csp-report`, which is public by necessity — browsers send them without
cookies, often from the sign-in page where there is no session. It stores nothing, always
answers `204`, and deliberately does not log `script-sample`, which can contain a fragment
of whatever the page was handling: on a POS, a customer's phone number or a payment
reference. A security log that quietly accumulates fragments of real transactions is its own
problem.

`tests/unit/security-headers.test.ts` asserts all of the above, including that
`'unsafe-inline'` never appears in the enforcing policy.

The desktop application's WebView has a fully enforcing CSP. It serves a static bundle with
no inline scripts, so it can.

## What the tests prove

```bash
pnpm test:db
```

Real PostgreSQL. Real `authenticated` role. Real JWT claims. Real policies. Nothing mocked.
See [TESTING.md](TESTING.md) for why this runs without Docker.

| Suite                  | Covers                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness`              | The harness itself: real Postgres, `SET ROLE` took effect, `auth.uid()` resolves                                                                               |
| `rls-coverage`         | **Every** table has RLS enabled _and_ forced; no policy reads client input; every `SECURITY DEFINER` function pins its search path; `anon` holds no privileges |
| `rls-tenant-isolation` | SELECT/INSERT/UPDATE/DELETE across tenants, joins, aggregates, membership status, tenant standing                                                              |
| `rls-branch-and-roles` | Branch scoping, role restrictions, role-rank escalation                                                                                                        |
| `rls-platform-access`  | Platform admin vs tenant data, support-grant lifecycle                                                                                                         |
| `schema-constraints`   | Cross-tenant references, money arithmetic, ledger direction, immutability                                                                                      |

### Two things worth knowing when reading these tests

**Reads and writes fail differently.** RLS refuses a forbidden read by returning **zero rows**;
a forbidden INSERT raises **SQLSTATE 42501**; a forbidden UPDATE or DELETE matches **zero rows
and reports success**. All three are safe. They are not the same, and a test must assert the
one that applies — hence both `expectDenied` and `expectNoRowsAffected`.

**`expectDenied` is strict about _why_ a statement failed.** A query that fails from a typo
would otherwise look like a passing security test. A non-privilege error is reported as a
harness failure. This is what surfaced the `profiles` recursion bug above.

The coverage detectors have themselves been verified against a deliberately unprotected table
and an unpinned function, to confirm they can actually fail.

---

## Threat model

| Threat                     | Mitigation                                                                  |
| -------------------------- | --------------------------------------------------------------------------- |
| SQL injection              | Parameterised queries throughout; no dynamic SQL in application code        |
| Broken access control      | RLS on every table, enforced by a coverage test                             |
| Tenant escape              | Policies derive from verified identity only; cross-tenant triggers          |
| Privilege escalation       | Role ranking; separated permissions; no privilege column on user-owned rows |
| Manipulated prices         | Prices are never accepted from a client — the server derives them           |
| Manipulated totals         | Server computes; a `CHECK` asserts the arithmetic in the row                |
| Manipulated stock          | No direct write path; ledger + cached total reconciled by test              |
| Duplicate transactions     | Idempotency keys enforced by a unique index, not application logic          |
| Replay after reconnect     | Same mechanism; the original result is returned                             |
| Stolen terminal            | Device secrets hashed; revocable; `authorized_until` bounds offline life    |
| Insecure activation codes  | CSPRNG, hashed, single-use by unique index, ≤ 48 hours by `CHECK`           |
| Leaked service credential  | `server-only` makes client import a build failure; gitleaks in CI           |
| Support engineer overreach | Time-boxed, reasoned, customer-visible grants                               |
| Audit tampering            | Append-only triggers refusing UPDATE/DELETE for every role                  |
| XSS                        | React escapes on render; input is not pre-escaped, which would corrupt data |
| Clickjacking               | `X-Frame-Options: DENY`                                                     |

---

## Reporting a vulnerability

Contact the Carl platform team directly. Do not open a public issue.
