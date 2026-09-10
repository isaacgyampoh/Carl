import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `Field` renders its own `<input>`. It is not a wrapper.
 *
 * Because `FieldProps extends InputHTMLAttributes<HTMLInputElement>`, `children` is a valid
 * prop as far as TypeScript is concerned — so `<Field><input /></Field>` compiles, builds,
 * and then fails at render with:
 *
 *     Error: input is a self-closing tag and must neither have `children` nor use
 *     `dangerouslySetInnerHTML`.
 *
 * That took the owner's settings and onboarding pages down in production with a 500, and
 * nothing before this test could catch it: the type checker allowed it, the build allowed
 * it, and no test rendered those pages.
 *
 * A `<select>` or `<textarea>` cannot go through `Field` at all — they need their own
 * label and markup.
 */
describe('Field is used as an input, not a wrapper', () => {
  const appDir = join(import.meta.dirname, '..', '..', 'apps', 'web', 'src');

  function* sources(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) yield* sources(full);
      else if (entry.name.endsWith('.tsx')) yield full;
    }
  }

  const files = [...sources(appDir)].filter((f) => readFileSync(f, 'utf8').includes('<Field'));

  it('finds the components that use Field', () => {
    // A guard on the guard: if the import is ever renamed, this test must not quietly pass
    // by checking nothing.
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [f.slice(appDir.length + 1), f] as const))(
    '%s never gives Field children',
    (_label, file) => {
      const source = readFileSync(file, 'utf8');

      /*
       * Every `<Field` must close itself with `/>` before the next element begins. Scanning
       * forward to the first `>` that terminates the tag tells us whether it self-closed.
       */
      for (const match of source.matchAll(/<Field\b/g)) {
        const rest = source.slice(match.index);
        // The end of this opening tag, ignoring `>` inside braces or strings.
        let depth = 0;
        let end = -1;
        for (let i = 0; i < rest.length; i += 1) {
          const ch = rest[i];
          if (ch === '{') depth += 1;
          else if (ch === '}') depth -= 1;
          else if (ch === '>' && depth === 0) {
            end = i;
            break;
          }
        }
        expect(end, 'unterminated <Field tag').toBeGreaterThan(-1);
        const selfClosed = rest[end - 1] === '/';
        const snippet = rest.slice(0, Math.min(end + 1, 90)).replace(/\s+/g, ' ');
        expect(selfClosed, `Field is wrapping content: ${snippet}`).toBe(true);
      }
    },
  );
});
