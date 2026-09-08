# Carl

Point of sale, inventory and business management for multi-branch retail.

Carl is a multi-tenant SaaS platform. One deployment serves many independent businesses, each
with its own branches, staff, stock and POS terminals. Terminals keep selling when the
internet does not.

> **Status: under construction.** This README describes what is implemented today, not what is
> planned. Phase progress is tracked in [`docs/PHASES.md`](docs/PHASES.md).

---

## Requirements

| Tool           | Version                       | Required for                                     |
| -------------- | ----------------------------- | ------------------------------------------------ |
| Node.js        | ≥ 22                          | everything                                       |
| pnpm           | ≥ 10 (`corepack enable pnpm`) | everything                                       |
| Supabase CLI   | ≥ 2.100                       | migrations, type generation                      |
| Docker         | any                           | `supabase start` only — **not** needed for tests |
| Rust toolchain | stable                        | the Tauri desktop app (Phase 11)                 |

The database and RLS test suites run in-process on WebAssembly PostgreSQL and need none of the
above beyond Node. That is deliberate: a security suite that requires Docker to be running is a
security suite that stops being run.

## Getting started

```bash
corepack enable pnpm
pnpm install
cp .env.example .env.local     # then fill in the values
pnpm dev
```

## Everyday commands

```bash
pnpm dev              # run the web app
pnpm typecheck        # every package
pnpm lint             # includes the architectural dependency rules
pnpm test             # unit + database/RLS suites
pnpm test:unit        # fast: pure logic only
pnpm test:db          # real PostgreSQL, real RLS policies
pnpm build            # production build
pnpm verify           # everything above, in the order CI runs it
```

`pnpm verify` is the gate. Nothing merges without it passing.

## Repository layout

```
apps/
  web/                 Next.js application (web + PWA)
packages/
  shared/              Primitives: money, quantity, Result, errors, IDs, logging
  domain/              Business rules. No framework, no I/O, no database.
  application/         Use cases and the ports they depend on
  infrastructure/      Supabase adapters, configuration, external services
  database/            RPC contracts and PostgreSQL error translation
  validation/          Zod schemas for the application boundary
  types/               Types generated from the database schema
  ui/                  Shared presentational components
supabase/
  migrations/          Schema, as ordered SQL migrations
  seed/                Development seed data
tests/
  support/             Test harness, including the PostgreSQL test database
  db/                  Schema, constraint and RLS tests
  integration/         Cross-module behaviour
```

## Documentation

| Document                                | Covers                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------ |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layering, module boundaries, why the database is part of the application |
| [SECURITY.md](docs/SECURITY.md)         | Tenant isolation, the RLS model, threat model, key handling              |
| [DATABASE.md](docs/DATABASE.md)         | Schema, constraints, indexes, transactional functions                    |
| [TESTING.md](docs/TESTING.md)           | The test pyramid and how to run the database suite                       |
| [PHASES.md](docs/PHASES.md)             | Build sequence and current status                                        |

## Licence

Proprietary. All rights reserved.
