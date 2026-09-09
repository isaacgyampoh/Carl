import { defineConfig } from 'vitest/config';

/**
 * Carl runs two distinct kinds of automated test, and they have very different costs.
 *
 *   unit — pure domain/validation logic. Milliseconds. Run constantly.
 *   db   — real PostgreSQL. Migrations are applied, RLS policies are exercised as an
 *          actual database role. Seconds. Run before every commit and in CI.
 *
 * They are separate projects so a slow database suite never discourages running the fast one.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          globals: true,
          environment: 'node',
          include: [
            'packages/*/src/**/*.test.ts',
            'packages/*/src/**/*.test.tsx',
            'tests/unit/**/*.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'db',
          globals: true,
          environment: 'node',
          include: ['tests/db/**/*.test.ts', 'tests/integration/**/*.test.ts'],
          /*
           * Generous timeouts, deliberately.
           *
           * A clean run of this suite takes about 50 seconds. On a loaded machine — a CI
           * runner sharing a host, or a developer with a build going — the same run has
           * been measured at 180 seconds, and a tighter limit turns that into a `beforeEach`
           * timeout attributed to whichever file happened to be running.
           *
           * That failure mode is expensive: it looks like a flaky test, so it gets re-run
           * rather than diagnosed, and a suite people re-run is a suite whose security
           * tests nobody trusts. Contention should make the suite slow, not red.
           */
          testTimeout: 120_000,
          hookTimeout: 300_000,
          // Files run one at a time so a failure is attributable and the machine is not
          // asked to hold a dozen PostgreSQL instances at once.
          fileParallelism: false,

          /*
           * Each file gets a fresh child process.
           *
           * PGlite is PostgreSQL compiled to WebAssembly, and a WASM instance's linear
           * memory is not reclaimed promptly when the module is dropped — it is freed when
           * the process holding it exits. Reusing one worker across every database file
           * accumulated that memory until an arbitrary later file failed.
           *
           * The symptom was a suite that passed in isolation but failed roughly one run in
           * three, in a *different* file each time. That is worse than an outright bug: a
           * suite people learn to re-run is a suite whose security tests nobody trusts.
           */
          pool: 'forks',
          // Top-level in Vitest 4+. Nested `poolOptions` was removed and is now ignored
          // with only a deprecation warning — which is exactly how a configuration change
          // can appear to work while doing nothing.
          isolate: true,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', 'packages/types/**'],
    },
  },
});
