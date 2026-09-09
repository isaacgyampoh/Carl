// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

/**
 * Carl lint configuration.
 *
 * Beyond ordinary code quality, this config mechanically enforces the Clean Architecture
 * dependency rule. Layer boundaries that exist only as documentation get violated; the ones
 * enforced here fail CI instead.
 *
 *   domain        -> depends on nothing (no framework, no I/O)
 *   validation    -> zod only
 *   application   -> domain + validation (ports, not adapters)
 *   infrastructure-> may use Supabase SDK and Node APIs
 *   ui/web        -> may use React/Next, must not reimplement domain rules
 */

/** Packages that must never reach for a framework, an SDK, or the network. */
const FRAMEWORK_FREE = [
  {
    group: ['react', 'react-*', 'next', 'next/*', 'react-dom', 'react-dom/*'],
    message:
      'The domain/application layer must stay framework-independent. Move UI concerns to packages/ui or apps/web.',
  },
  {
    group: ['@supabase/*', 'postgres', 'pg', 'kysely', 'drizzle-orm'],
    message:
      'The domain/application layer must not depend on a database driver. Define a port here and implement it in packages/infrastructure.',
  },
  {
    group: ['@carl/infrastructure', '@carl/infrastructure/*', '@carl/ui', '@carl/ui/*'],
    message:
      'Dependency rule violation: inner layers must not import outer layers. Invert the dependency with a port.',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/build/**',
      '**/*.d.ts',
      // Linted by its own rules would require a tsconfig that includes it; it is plain ESM
      // with no Carl code in it, so it is excluded rather than given a synthetic project.
      'eslint.config.mjs',
      '**/src-tauri/target/**',
      'packages/types/src/database.generated.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // Correctness over convenience.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',

      // Secrets must never be reachable from code that can ship to a client bundle.
      'no-restricted-globals': [
        'error',
        {
          name: 'localStorage',
          message: 'Use the storage port so offline behaviour stays testable.',
        },
      ],
    },
  },

  /*
   * ---- The Tauri boundary ---------------------------------------------------
   *
   * `@tauri-apps/*` exists only inside the desktop application. Everywhere else it is a
   * build error.
   *
   * This is not tidiness. The Tauri modules are bare specifiers that only resolve when
   * bundled for a WebView; imported from the web application they would either break the
   * Vercel build or, worse, survive into a browser bundle that cannot resolve them at
   * runtime — which is precisely the failure that shipped inside a release `.app`:
   *
   *     Module name, '@tauri-apps/plugin-sql' does not resolve to a valid URL
   *
   * The shared packages define `SqliteConnection` as a port. The desktop supplies a Tauri
   * adapter, the tests supply a Node one, and nothing above that line knows either exists.
   */
  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tauri-apps/*', '@tauri-apps'],
              message:
                'Tauri modules belong in apps/desktop only. Depend on the SqliteConnection ' +
                'port instead, and let the desktop supply the adapter.',
            },
          ],
        },
      ],
    },
  },

  // ---- Layer boundaries -----------------------------------------------------
  {
    files: ['packages/domain/**/*.ts', 'packages/application/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: FRAMEWORK_FREE }],
      'no-restricted-globals': [
        'error',
        {
          name: 'window',
          message: 'Domain and application layers must not touch browser globals.',
        },
        {
          name: 'document',
          message: 'Domain and application layers must not touch browser globals.',
        },
        {
          name: 'localStorage',
          message: 'Domain and application layers must not touch browser globals.',
        },
        { name: 'fetch', message: 'Define a port; let infrastructure own the network.' },
      ],
    },
  },
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...FRAMEWORK_FREE,
            {
              group: [
                '@carl/application',
                '@carl/application/*',
                '@carl/validation',
                '@carl/validation/*',
              ],
              message:
                'The domain is the innermost layer and imports nothing from Carl except @carl/shared.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/ui/**/*.{ts,tsx}', 'apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@carl/infrastructure/server/*'],
              message:
                'Server-only infrastructure must not be imported from a module that can end up in the client bundle.',
            },
          ],
        },
      ],
    },
  },

  // ---- Service worker -------------------------------------------------------
  // Served verbatim from `public/`, so it is outside any tsconfig and cannot be
  // type-checked. It still gets the correctness rules, with the ServiceWorkerGlobalScope
  // globals it actually runs against.
  {
    files: ['apps/web/public/sw.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: { projectService: false, project: null },
      globals: { ...globals.serviceworker },
    },
  },

  // ---- Tests ----------------------------------------------------------------
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      'no-console': 'off',
    },
  },

  // ---- Config / script files ------------------------------------------------
  // These live outside any tsconfig `include`, so type-aware rules cannot run on them.
  // The rules are merged rather than replaced: assigning `rules` after the spread would
  // discard exactly the "off" switches that make this block work.
  {
    files: ['**/*.config.{ts,mts,mjs,js}', '**/*.setup.{ts,mts,mjs}', 'scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: { projectService: false, project: null },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },

  prettier,
);
