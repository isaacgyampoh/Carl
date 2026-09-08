/**
 * Regenerates the permissions seed migration from packages/domain.
 *
 * The catalogue in @carl/domain is the single source of truth. Rather than maintaining a
 * parallel list in SQL by hand — which drifts the first time someone is in a hurry — the
 * migration is generated from it, and a database test asserts the two still agree.
 *
 * Run: node scripts/generate-permissions-migration.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'packages/domain/src/access/permissions.ts');
const TARGET = join(ROOT, 'supabase/migrations/20260101001000_seed_permissions.sql');

const source = readFileSync(SOURCE, 'utf8');

// Read the catalogue without importing TypeScript: the values are simple string literals.
const keys = [...source.matchAll(/^\s{2}[A-Z_]+:\s*'([a-z_]+\.[a-z_]+)',$/gm)].map((m) => m[1]);
if (keys.length === 0) throw new Error(`No permissions parsed from ${SOURCE}`);

const describe = (resource, action) =>
  `${action.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())} — ${resource.replace(/_/g, ' ')}`;

const rows = keys
  .map((key) => {
    const [resource, action] = key.split('.');
    return `  ('${key}', '${resource}', '${action}', ${sqlString(describe(resource, action))})`;
  })
  .join(',\n');

function sqlString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

writeFileSync(
  TARGET,
  `-- =============================================================================
-- 0010 · Permission catalogue seed
--
-- GENERATED FILE — do not edit by hand.
--
-- Regenerate with:  node scripts/generate-permissions-migration.mjs
-- Source of truth:  packages/domain/src/access/permissions.ts
--
-- tests/db/permissions.test.ts asserts this table and the TypeScript catalogue contain
-- exactly the same keys, so adding a permission and forgetting to regenerate is a
-- failing test rather than a silent authorization hole.
--
-- ${keys.length} permissions.
-- =============================================================================

insert into permissions (key, resource, action, description) values
${rows}
on conflict (key) do update
  set resource    = excluded.resource,
      action      = excluded.action,
      description = excluded.description;
`,
  'utf8',
);

console.log(`Wrote ${keys.length} permissions to ${TARGET.replace(ROOT + '/', '')}`);
