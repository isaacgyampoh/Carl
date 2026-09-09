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

  // --- foreign keys ---
  //
  // PostgREST resolves an embedded select (`select('id, categories(name)')`) through the
  // foreign keys between the tables, and @supabase/supabase-js types that resolution from
  // the `Relationships` array. Emitting it empty makes every embedded select fail to
  // typecheck, which pushes call sites toward `.returns<T>()` overrides — and an override
  // is an assertion, not a check.
  const relationshipRows = await db.query(`
    select
      con.conname                                   as constraint_name,
      src.relname                                   as source_table,
      tgt.relname                                   as target_table,
      array(
        select a.attname
        from unnest(con.conkey) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
        order by k.ord
      )                                             as source_columns,
      array(
        select a.attname
        from unnest(con.confkey) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum
        order by k.ord
      )                                             as target_columns,
      exists (
        select 1 from pg_index i
        where i.indrelid = con.conrelid
          and i.indisunique
          and i.indkey::int2[] @> con.conkey
          and array_length(con.conkey, 1) = i.indnatts
      )                                             as is_one_to_one
    from pg_constraint con
    join pg_class src on src.oid = con.conrelid
    join pg_class tgt on tgt.oid = con.confrelid
    join pg_namespace n on n.oid = src.relnamespace
    where con.contype = 'f' and n.nspname = 'public'
    order by src.relname, con.conname
  `);

  const relationships = new Map();
  for (const row of relationshipRows.rows) {
    if (!relationships.has(row.source_table)) relationships.set(row.source_table, []);
    relationships.get(row.source_table).push(row);
  }

  // --- functions callable as RPC ---
  //
  // Argument and result columns are read from the catalogue rather than by parsing
  // pg_get_function_result's text, so a RETURNS TABLE function is typed as the row shape
  // callers actually receive. Without this the client cannot tell a set-returning function
  // from a scalar one, and `.returns<T[]>()` fails to typecheck against `unknown`.
  const functionRows = await db.query(`
    select
      p.proname                                  as name,
      p.proretset                                as returns_set,
      p.pronargdefaults                          as defaults_count,
      coalesce(rt.typname, '')                   as return_type,
      coalesce(p.proargnames, '{}')              as arg_names,
      coalesce(p.proargmodes, '{}')              as arg_modes,
      coalesce(
        array(
          select coalesce(bt.typname, t.typname)
          from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) with ordinality as a(oid, ord)
          join pg_type t on t.oid = a.oid
          left join pg_type bt on t.typtype = 'd' and bt.oid = t.typbasetype
          order by a.ord
        ),
        '{}'
      )                                          as arg_types
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    left join pg_type rt on rt.oid = p.prorettype
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

    const rels = relationships.get(name) ?? [];
    if (rels.length === 0) {
      lines.push('        Relationships: [];');
    } else {
      lines.push('        Relationships: [');
      for (const rel of rels) {
        lines.push('          {');
        lines.push(`            foreignKeyName: '${rel.constraint_name}';`);
        lines.push(`            columns: [${rel.source_columns.map((c) => `'${c}'`).join(', ')}];`);
        lines.push(`            isOneToOne: ${rel.is_one_to_one ? 'true' : 'false'};`);
        lines.push(`            referencedRelation: '${rel.target_table}';`);
        lines.push(
          `            referencedColumns: [${rel.target_columns.map((c) => `'${c}'`).join(', ')}];`,
        );
        lines.push('          },');
      }
      lines.push('        ];');
    }
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

  lines.push('    Functions: {');
  for (const fn of functionRows.rows) {
    const names = fn.arg_names ?? [];
    const modes = fn.arg_modes ?? [];
    const types = fn.arg_types ?? [];

    // Mode 'i' is IN, 'b' is INOUT, 'v' is VARIADIC; 'o' and 't' are OUT/TABLE columns.
    // An empty modes array means every argument is IN.
    const isInput = (i) => modes.length === 0 || ['i', 'b', 'v'].includes(modes[i]);
    const isOutput = (i) => modes.length > 0 && ['o', 'b', 't'].includes(modes[i]);

    // The last `pronargdefaults` input arguments are the ones with DEFAULTs, and only
    // those are optional. Marking every argument optional would let a required tenant id be
    // omitted silently.
    const inputIndexes = [];
    for (let i = 0; i < types.length; i += 1) if (isInput(i)) inputIndexes.push(i);
    const optionalFrom = inputIndexes.length - (fn.defaults_count ?? 0);

    const args = [];
    const outputs = [];
    for (let i = 0; i < types.length; i += 1) {
      const argName = names[i] ?? `arg${i}`;
      if (isInput(i)) {
        const optional = inputIndexes.indexOf(i) >= optionalFrom;
        const type = tsType(types[i], enumNames);
        // `| undefined` is required because Carl compiles with exactOptionalPropertyTypes,
        // under which `x?: string` rejects an explicit `undefined`.
        args.push(
          `          ${argName}${optional ? '?' : ''}: ${type}${optional ? ' | undefined' : ''};`,
        );
      }
      if (isOutput(i)) outputs.push(`    ${argName}: ${tsType(types[i], enumNames)} | null;`);
    }

    const returns =
      outputs.length > 0
        ? `{\n${outputs.join('\n')}\n  }${fn.returns_set ? '[]' : ''}`
        : `${tsType(fn.return_type, enumNames)}${fn.returns_set ? '[]' : ''}`;

    lines.push(`      ${fn.name}: {`);
    lines.push('        Args: {');
    lines.push(...args);
    lines.push('        };');
    lines.push(`        Returns: ${returns};`);
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
