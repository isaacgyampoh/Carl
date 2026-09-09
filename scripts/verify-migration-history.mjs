/**
 * Checks that a deployed database's migration history matches the repository.
 *
 * ## Why this exists
 *
 * Migrations applied by hand — with `psql`, the SQL editor, or a script — change the
 * database without telling `supabase_migrations.schema_migrations`. The database is then
 * correct and its ledger is wrong, which is invisible until the next `supabase db push`
 * tries to re-apply migrations that have already run.
 *
 * That is not hypothetical: three of Carl's migrations were applied that way and went
 * unrecorded until this check was written.
 *
 * Read-only. It reports drift and never repairs it, because "the ledger disagrees with the
 * database" has two possible causes — an unrecorded migration, or a migration that never
 * ran — and they need opposite responses.
 *
 *   SUPABASE_DB_URL=... node scripts/verify-migration-history.mjs
 */
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');

const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) {
  console.error('SUPABASE_DB_URL is required.');
  process.exit(2);
}

const files = (await readdir(MIGRATIONS))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((file) => ({ version: file.split('_')[0], file }));

// Ordering is the property `supabase db push` relies on, so it is checked before anything
// touches the network.
const versions = files.map((f) => f.version);
const sorted = [...versions].sort();
const ordered = versions.every((v, i) => v === sorted[i]);
const duplicates = versions.filter((v, i) => versions.indexOf(v) !== i);

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20_000,
});
await client.connect();

let recorded;
try {
  const { rows } = await client.query(
    'select version from supabase_migrations.schema_migrations order by version',
  );
  recorded = new Set(rows.map((r) => r.version));
} finally {
  await client.end();
}

const missing = files.filter((f) => !recorded.has(f.version));
const orphaned = [...recorded].filter((v) => !versions.includes(v));

const problems = [];
if (!ordered) problems.push('migration filenames do not sort into application order');
if (duplicates.length > 0) problems.push(`duplicate versions: ${duplicates.join(', ')}`);
if (missing.length > 0) {
  problems.push(
    `applied by hand or never applied — not in the history: ${missing.map((m) => m.file).join(', ')}`,
  );
}
if (orphaned.length > 0) {
  // A recorded version with no file means the repository lost a migration the database
  // still has. Deleting the row would hide that; it needs a person.
  problems.push(`recorded in the database but missing from the repository: ${orphaned.join(', ')}`);
}

console.log(`migration files:    ${files.length}`);
console.log(`recorded in the db: ${recorded.size}`);
console.log(`filenames ordered:  ${ordered ? 'yes' : 'NO'}`);

if (problems.length === 0) {
  console.log('\n✓ the deployed history matches the repository');
  process.exit(0);
}
console.error('\n✗ migration history drift:');
for (const p of problems) console.error(`   - ${p}`);
process.exit(1);
