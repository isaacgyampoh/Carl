import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The screens someone meets before signing in.
 *
 * They are the first thing a shopkeeper sees of software they pay for, and the first thing
 * their customers see over the counter, so they share one backdrop rather than each being a
 * form on a white page.
 *
 * Two rules hold the design together, and both are asserted here because both are easy to
 * break by accident: the decoration is drawn rather than downloaded, and it stays behind the
 * card so nothing a person must read loses contrast to it.
 */
const web = (...p: string[]) =>
  readFileSync(join(import.meta.dirname, '..', '..', 'apps', 'web', 'src', ...p), 'utf8');

const DOORS: [string, string[]][] = [
  ["the owner's PIN and the till finder on the shops' hostname", ['app', 'page.tsx']],
  ['the till finder', ['app', 'find-shop', 'page.tsx']],
  ["a business's own door", ['app', '[slug]', 'page.tsx']],
  ["a till's door", ['app', '[slug]', 'pos', 'page.tsx']],
  ['the email sign-in', ['app', 'sign-in', 'page.tsx']],
];

describe('every door', () => {
  it.each(DOORS)('%s uses the shared screen', (_name, path) => {
    const source = web(...path);
    expect(source).toContain('<DoorScreen');
    expect(source).toContain("from '@/components/door-screen'");
  });

  it.each(DOORS)('%s leaves the backdrop to that screen', (_name, path) => {
    // A page painting its own background is how five doors drift apart.
    const source = web(...path);
    expect(source).not.toMatch(/className="[^"]*min-h-dvh[^"]*"/);
  });
});

describe('the backdrop', () => {
  const door = web('components', 'door-screen.tsx');

  it('is drawn, not downloaded — a till on one bar waits for nothing', () => {
    expect(door).not.toMatch(/<img|url\(|\.jpg|\.png|\.webp|next\/image/);
    expect(door).toContain('linear-gradient');
  });

  it('is decoration: hidden from screen readers and not in the way of a tap', () => {
    expect(door).toContain('aria-hidden');
    expect(door).toContain('pointer-events-none');
  });

  it('stays behind the card, which keeps its own solid background', () => {
    expect(door).toContain('-z-10');
    // Full contrast for every word: a PIN prompt, an error, a business's name.
    expect(door).toContain('bg-[color:var(--color-surface)]');
    expect(door).not.toMatch(/bg-\[color:var\(--color-surface\)\]\/\d/);
  });

  it('does not leak its decoration outside the screen', () => {
    expect(door).toContain('overflow-hidden');
  });
});
