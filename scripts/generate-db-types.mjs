/**
 * Generates `packages/types/src/database.generated.ts` from the migrations.
 *
 * The Supabase CLI's `gen types` needs a reachable PostgreSQL instance, which in practice
 * means Docker. Carl's test harness already applies the real migrations to an in-process
 * PostgreSQL (PGlite), so this introspects that instead: same migrations, same catalogue,
 * no daemon. It runs anywhere Node runs, including CI.
 *
 * The output matches the shape `@supabase/supabase-js` expects, so `supabase.from('sales')`
 * is fully typed and a renamed column becomes a compile error.
 *
 * Run: pnpm db:types
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(ROOT, 'supabase/migrations');
const SHIM = join(ROOT, 'tests/support/supabase-shim.sql');
const TARGET = join(ROOT, 'packages/types/src/database.generated.ts');

/** PostgreSQL type -> TypeScript type. */
const TYPE_MAP = {
  uuid: 'string',
  text: 'string',
  citext: 'string',
  varchar: 'string',
  bpchar: 'string',
  name: 'string',
  inet: 'string',
  date: 'string',
  timestamp: 'string',
  timestamptz: 'string',
  time: 'string',
  timetz: 'string',
  interval: 'string',
  bytea: 'string',
  int2: 'number',
  int4: 'number',
  float4: 'number',
  float8: 'number',
  // int8 and numeric exceed what a double can represent exactly. PostgREST returns them
  // as JSON numbers when they fit, and Carl keeps money well inside the safe integer
  // range, so `number` is correct here — see packages/shared/src/money.ts.
  int8: 'number',
  numeric: 'number',
  bool: 'boolean',
  json: 'Json',
  jsonb: 'Json',
};

function tsType(dataType, enums) {
  if (enums.has(dataType)) return enumName(dataType);
  const base = dataType.startsWith('_') ? dataType.slice(1) : dataType;
  const mapped = TYPE_MAP[base] ?? (enums.has(base) ? enumName(base) : 'unknown');
  return dataType.startsWith('_') ? `${mapped}[]` : mapped;
}

const enumName = (name) => `Database['public']['Enums']['${name}']`;

async function main() {
  const db = await PGlite.create({ extensions: { pgcrypto, pg_trgm, citext } });
  await db.exec(await readFile(SHIM, 'utf8'));

  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    await db.exec(await readFile(join(MIGRATIONS, file), 'utf8'));
  }

  // --- enums ---
  const enumRows = await db.query(`
    select t.typname as name, array_agg(e.enumlabel order by e.enumsortorder) as labels
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
    group by t.typname
    order by t.typname
  `);
  const enumNames = new Set(enumRows.rows.map((r) => r.name));

  // --- tables and views ---
  //
  // `attnotnull` and the presence of a default are what decide optionality on Insert:
  // a NOT NULL column with a default (an id, a created_at) must not be required.
  const columnRows = await db.query(`
    select
      c.relname                                   as table_name,
      c.relkind                                   as kind,
      a.attname                                   as column_name,
      a.attnum                                    as position,
      coalesce(bt.typname, t.typname)             as data_type,
      a.attnotnull                                as not_null,
      (ad.adbin is not null)                      as has_default,
      a.attidentity <> ''                         as is_identity,
      pg_catalog.col_description(c.oid, a.attnum) as comment
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    join pg_type t on t.oid = a.atttypid
    left join pg_type bt on t.typtype = 'd' and bt.oid = t.typbasetype
    left join pg_attrdef ad on ad.adrelid = c.oid and ad.adnum = a.attnum
    where n.nspname = 'public' and c.relkind in ('r', 'v')
    order by c.relname, a.attnum
  `);

  const relations = new Map();
  for (const row of columnRows.rows) {
    if (!relations.has(row.table_name)) {
      relations.set(row.table_name, { kind: row.kind, columns: [] });
    }
    relations.get(row.table_name).columns.push(row);
  }

  // --- functions callable as RPC ---
  const functionRows = await db.query(`
    select p.proname as name, pg_get_function_result(p.oid) as returns
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
    order by p.proname
  `);

  await db.close();

  // --- emit ---
  const lines = [];
  lines.push(`/**
 * Types generated from Carl's migrations.
 *
 * GENERATED FILE — do not edit by hand. Regenerate with \`pnpm db:types\`.
 *
 * Produced by introspecting the real migrations applied to an in-process PostgreSQL, so it
 * needs no Docker and stays correct in CI. See scripts/generate-db-types.mjs.
 *
 * ${relations.size} relations, ${enumNames.size} enums, ${functionRows.rows.length} functions.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
`);

  lines.push('export interface Database {');
  lines.push('  public: {');

  // Tables
  lines.push('    Tables: {');
  for (const [name, relation] of [...relations].filter(([, r]) => r.kind === 'r')) {
    lines.push(`      ${name}: {`);
    lines.push('        Row: {');
    for (const column of relation.columns) {
      const type = tsType(column.data_type, enumNames);
      lines.push(`          ${column.column_name}: ${type}${column.not_null ? '' : ' | null'};`);
    }
    lines.push('        };');

    lines.push('        Insert: {');
    for (const column of relation.columns) {
      const type = tsType(column.data_type, enumNames);
      // Required only when the database offers no value of its own.
      const optional = !column.not_null || column.has_default || column.is_identity;
      lines.push(
        `          ${column.column_name}${optional ? '?' : ''}: ${type}${column.not_null ? '' : ' | null'};`,
      );
    }
    lines.push('        };');

    lines.push('        Update: {');
    for (const column of relation.columns) {
      const type = tsType(column.data_type, enumNames);
      lines.push(`          ${column.column_name}?: ${type}${column.not_null ? '' : ' | null'};`);
    }
    lines.push('        };');
    lines.push('        Relationships: [];');
    lines.push('      };');
  }
  lines.push('    };');

  // Views
  lines.push('    Views: {');
  for (const [name, relation] of [...relations].filter(([, r]) => r.kind === 'v')) {
    lines.push(`      ${name}: {`);
    lines.push('        Row: {');
    for (const column of relation.columns) {
      const type = tsType(column.data_type, enumNames);
      lines.push(`          ${column.column_name}: ${type} | null;`);
    }
    lines.push('        };');
    lines.push('        Relationships: [];');
    lines.push('      };');
  }
  lines.push('    };');

  // Functions — argument typing is left to callers, which pass a checked payload.
  lines.push('    Functions: {');
  for (const fn of functionRows.rows) {
    lines.push(`      ${fn.name}: {`);
    lines.push('        Args: Record<string, unknown>;');
    lines.push('        Returns: unknown;');
    lines.push('      };');
  }
  lines.push('    };');

  // Enums
  lines.push('    Enums: {');
  for (const row of enumRows.rows) {
    lines.push(`      ${row.name}: ${row.labels.map((l) => `'${l}'`).join(' | ')};`);
  }
  lines.push('    };');

  lines.push('    CompositeTypes: Record<string, never>;');
  lines.push('  };');
  lines.push('}');
  lines.push('');

  // Convenience aliases, so call sites read as `Row<'sales'>` rather than a five-level index.
  lines.push(`
export type Tables = Database['public']['Tables'];
export type Views = Database['public']['Views'];
export type Enums = Database['public']['Enums'];

export type Row<T extends keyof Tables> = Tables[T]['Row'];
export type InsertRow<T extends keyof Tables> = Tables[T]['Insert'];
export type UpdateRow<T extends keyof Tables> = Tables[T]['Update'];
export type ViewRow<T extends keyof Views> = Views[T]['Row'];
`);

  await writeFile(TARGET, lines.join('\n'), 'utf8');
  console.log(
    `Generated ${relations.size} relations, ${enumNames.size} enums, ` +
      `${functionRows.rows.length} functions -> ${TARGET.replace(ROOT + '/', '')}`,
  );
}

await main();
