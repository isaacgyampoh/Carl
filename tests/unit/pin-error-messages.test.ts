import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What a PIN screen is allowed to say.
 *
 * A shopkeeper standing at a till, and the person who owns Carl, are both non-technical.
 * Neither should ever be shown the word "database", let alone a stack trace — and this is
 * not hypothetical: the owner's sign-in screen displayed "The database could not be
 * reached." in production, because the error mapping passed the server's message straight
 * through.
 *
 * The fix was to translate by ALLOWLIST — only named conditions get their own wording,
 * everything else becomes one neutral sentence. These tests pin that shape, because a
 * denylist would have to anticipate every failure that has not happened yet.
 */
describe('PIN screens never leak technical errors', () => {
  const screens = [
    ['owner', join('apps', 'web', 'src', 'components', 'owner-pin-pad.tsx')],
    ['shop staff', join('apps', 'web', 'src', 'app', '[slug]', 'member-pin-pad.tsx')],
  ] as const;

  const read = (relative: string) =>
    readFileSync(join(import.meta.dirname, '..', '..', relative), 'utf8');

  describe.each(screens)('the %s screen', (_name, relative) => {
    const source = read(relative);

    it('translates errors through a default branch, not by passing the server message on', () => {
      // The `default:` case is what makes this an allowlist. Without it, an unanticipated
      // error code falls through to whatever the server said.
      expect(source).toContain('default:');
      expect(source).toContain('We’re having trouble connecting right now.');
    });

    it('offers a way to retry a connection failure', () => {
      expect(source).toContain('Try again');
    });

    it('renders no numeric keypad', () => {
      /*
       * Checked structurally rather than by searching for the word: the comments in these
       * files explain WHY there is no keypad, and matching on prose would fail on the
       * documentation instead of the markup.
       *
       * A rendered keypad means digit buttons that append to the value on click.
       */
      expect(source).not.toMatch(/onClick=\{\(\) =>\s*(setDigits|append|press)/);
      expect(source, 'a grid of digit buttons').not.toMatch(/\['1',\s*'2',\s*'3'/);
      expect(source, 'digits rendered as buttons').not.toMatch(/<button[^>]*>\s*\{?\s*digit/);
    });

    it('submits itself rather than waiting for a Confirm button', () => {
      expect(source).toContain('digits.length !== LENGTH');
      expect(source).not.toMatch(/>\s*(Confirm|Sign in|Continue|Open)\s*</);
    });

    it('mentions nothing a non-technical person should never see', () => {
      /*
       * Only the strings that could be RENDERED are checked — comments explain why the
       * allowlist exists and legitimately contain the offending words.
       */
      const rendered = [...source.matchAll(/(?:text:|>)\s*'([^']{8,})'/g)].map((m) => m[1]!);
      const forbidden =
        /database|postgres|supabase|sql|rpc|stack|exception|ECONN|500|timeout|token_hash/i;
      for (const line of rendered) {
        expect(forbidden.test(line), `a screen could render: ${line}`).toBe(false);
      }
    });
  });
});

/**
 * The error boundaries.
 *
 * Added after two owner pages threw during render with no boundary in place, so the browser
 * showed its own "This page couldn't load". A boundary that prints the exception would
 * simply move the leak, so these assert that neither renders error text, a digest, or a
 * stack.
 */
describe('error boundaries reveal nothing technical', () => {
  const read = (relative: string) =>
    readFileSync(join(import.meta.dirname, '..', '..', relative), 'utf8');

  const boundaries = [
    ['route', join('apps', 'web', 'src', 'app', 'error.tsx')],
    ['root', join('apps', 'web', 'src', 'app', 'global-error.tsx')],
  ] as const;

  it.each(boundaries)('the %s boundary exists', (_name, relative) => {
    expect(read(relative).length).toBeGreaterThan(0);
  });

  it.each(boundaries)('the %s boundary renders no exception detail', (_name, relative) => {
    const source = read(relative);
    // Rendering `{error.message}`, `{error.digest}` or a stack would put server internals on
    // a shop floor — which is the failure this whole boundary was added to prevent.
    expect(source).not.toMatch(/\{\s*error\.(message|digest|stack)\s*\}/);
    expect(source).not.toMatch(/\{\s*String\(error\)/);
    expect(source).not.toMatch(/\{\s*error\s*\}/);
  });

  it.each(boundaries)('the %s boundary offers a way out', (_name, relative) => {
    expect(read(relative)).toContain('Try again');
  });
});
