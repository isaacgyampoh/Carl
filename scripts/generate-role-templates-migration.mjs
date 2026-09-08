/**
 * Regenerates the role-template seed from packages/domain.
 *
 * Same reasoning as the permissions generator: the templates in @carl/domain are the source
 * of truth, and a hand-maintained SQL copy drifts. `provision_tenant()` copies from these
 * tables when a business is created.
 *
 * Run: node scripts/generate-role-templates-migration.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'supabase/migrations/20260101001400_seed_role_templates.sql');

// Evaluate the TypeScript sources rather than re-parsing them: the role templates compose
// permission arrays by spreading, so a regex would silently miss inherited grants.
const require = createRequire(import.meta.url);
const ts = require('typescript');

function loadModule(relativePath, injected = {}) {
  const source = readFileSync(join(ROOT, relativePath), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  const localRequire = (specifier) => {
    const resolved = injected[specifier];
    if (!resolved) throw new Error(`Unexpected import "${specifier}" in ${relativePath}`);
    return resolved;
  };
  new Function('require', 'module', 'exports', outputText)(localRequire, module, module.exports);
  return module.exports;
}

const permissions = loadModule('packages/domain/src/access/permissions.ts');
const roles = loadModule('packages/domain/src/access/roles.ts', {
  './permissions.js': permissions,
});

const templates = roles.ROLE_TEMPLATES;
if (!Array.isArray(templates) || templates.length === 0) {
  throw new Error('No role templates found in packages/domain/src/access/roles.ts');
}

const sql = (value) => `'${String(value).replace(/'/g, "''")}'`;

const templateRows = templates
  .map((t) => `  (${sql(t.key)}, ${sql(t.name)}, ${sql(t.description)}, ${t.rank})`)
  .join(',\n');

const grantRows = templates
  .flatMap((t) => t.permissions.map((p) => `  (${sql(t.key)}, ${sql(p)})`))
  .join(',\n');

writeFileSync(
  TARGET,
  `-- =============================================================================
-- 0014 · Role template seed
--
-- GENERATED FILE — do not edit by hand.
--
-- Regenerate with:  node scripts/generate-role-templates-migration.mjs
-- Source of truth:  packages/domain/src/access/roles.ts
--
-- provision_tenant() copies these into per-tenant \`roles\` rows. They are templates: a
-- tenant administrator may then edit the permissions on their own copy, because one
-- business's idea of "cashier" is not another's.
--
-- ${templates.length} templates, ${templates.reduce((n, t) => n + t.permissions.length, 0)} grants.
-- =============================================================================

create table if not exists role_templates (
  key         app.slug primary key,
  name        app.label not null,
  description text not null,
  rank        smallint not null,
  created_at  timestamptz not null default now(),

  constraint role_templates_rank_range check (rank between 0 and 100)
);

create table if not exists role_template_permissions (
  template_key   text not null references role_templates (key) on delete cascade,
  permission_key text not null references permissions (key) on delete cascade,
  primary key (template_key, permission_key)
);

alter table role_templates enable row level security;
alter table role_templates force row level security;
alter table role_template_permissions enable row level security;
alter table role_template_permissions force row level security;

-- Readable by any signed-in user so the role editor can offer them. Not sensitive: these
-- describe Carl's capabilities, not any business's configuration.
create policy role_templates_select on role_templates
  for select to authenticated using (true);
create policy role_template_permissions_select on role_template_permissions
  for select to authenticated using (true);

insert into role_templates (key, name, description, rank) values
${templateRows}
on conflict (key) do update
  set name = excluded.name, description = excluded.description, rank = excluded.rank;

-- Rewritten wholesale so a permission removed from a template in code is removed here too.
delete from role_template_permissions;

insert into role_template_permissions (template_key, permission_key) values
${grantRows}
on conflict do nothing;
`,
  'utf8',
);

console.log(
  `Wrote ${templates.length} role templates and ` +
    `${templates.reduce((n, t) => n + t.permissions.length, 0)} grants to ` +
    TARGET.replace(ROOT + '/', ''),
);
