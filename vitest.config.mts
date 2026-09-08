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
          // A migrated PostgreSQL instance takes a moment to stand up.
          testTimeout: 60_000,
          hookTimeout: 120_000,
          // Database tests share a schema; run files sequentially to keep failures readable.
          fileParallelism: false,
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
