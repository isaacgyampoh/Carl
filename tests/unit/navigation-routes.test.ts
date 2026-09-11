import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every internal link and redirect goes somewhere that exists.
 *
 * The owner's navigation pointed at /platform/installations and /platform/maintenance for
 * as long as those folders existed with no page inside them: two 404s one click from the
 * console's front page, and nothing failed. A dead link is invisible to every other test,
 * because nothing renders it until a person clicks.
 */
const SRC = join(import.meta.dirname, '..', '..', 'apps', 'web', 'src');
const APP = join(SRC, 'app');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Route patterns, with route groups removed and dynamic segments kept as [name]. */
const routes = walk(APP)
  .filter((file) => /\/(page\.tsx|route\.ts)$/.test(file))
  .map((file) => {
    const segments = relative(APP, file)
      .split('/')
      .slice(0, -1)
      .filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')));
    return segments;
  });

function resolves(target: string): boolean {
  const segments = target.split(/[?#]/)[0]!.split('/').filter(Boolean);
  return routes.some(
    (route) =>
      route.length === segments.length &&
      route.every(
        (part, i) => part === segments[i] || (part.startsWith('[') && part.endsWith(']')),
      ),
  );
}

const IGNORED = /^\/(api\/|_next|icon|manifest|sw\.js|platform\.webmanifest)/;
const LINK =
  /(?:href=|href:\s*|redirect\(|router\.(?:push|replace)\(|\[)\s*[{]?\s*['"`](\/[^'"`$?#]*)['"`]/g;

const targets = new Map<string, string[]>();
for (const file of walk(SRC).filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.'))) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(LINK)) {
    const target = match[1]!;
    if (IGNORED.test(target)) continue;
    targets.set(target, [...(targets.get(target) ?? []), relative(SRC, file)]);
  }
}

describe('internal navigation', () => {
  it('finds the links it is checking', () => {
    // Guards against the scanner silently matching nothing and passing vacuously.
    expect(targets.size).toBeGreaterThan(20);
    expect(targets.has('/platform/clients')).toBe(true);
  });

  it.each([...targets.entries()])('%s is a route that exists', (target, files) => {
    expect(resolves(target), `linked from ${files.join(', ')}`).toBe(true);
  });
});

describe('screens for when a page cannot be shown', () => {
  it.each([
    ['app/not-found.tsx', 'an unknown address'],
    ['app/error.tsx', 'a page that failed to render'],
    ['app/global-error.tsx', 'the root layout failing'],
    ['app/(app)/error.tsx', 'a failure inside the app shell, keeping navigation'],
    ['app/(app)/loading.tsx', 'the wait while a page loads its data'],
  ])('%s exists, for %s', (path) => {
    expect(existsSync(join(SRC, path))).toBe(true);
  });
});
