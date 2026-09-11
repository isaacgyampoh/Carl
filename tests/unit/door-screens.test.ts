import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * The screens someone meets before signing in.
 *
 * They are the first thing a shopkeeper sees of software they pay for, and the first thing
 * their customers see over the counter, so they share one backdrop rather than each being a
 * form on a white page.
 *
 * Three rules hold the design together, and all three are asserted here because all three are
 * easy to break by accident: there is one backdrop picture rather than five, it is small enough
 * for a shop on a slow connection to pay for it without noticing, and it stays behind the card
 * so nothing a person must read loses contrast to it.
 */
const repo = (...p: string[]) => join(import.meta.dirname, '..', '..', ...p);
const web = (...p: string[]) => readFileSync(repo('apps', 'web', 'src', ...p), 'utf8');

/** The only files these screens download. Everything else on them is markup. */
const PICTURES = ['commerce', 'shopfront'].flatMap((n) =>
  ['tall', 'wide'].map((shape) => repo('apps', 'web', 'public', 'door', `${n}-${shape}.webp`)),
);

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

  it.each(PICTURES)('%s is a file the doors actually ship', (file) => {
    expect(existsSync(file)).toBe(true);
    expect(door).toContain(`bg-[url('/door/${basename(file)}')]`);
  });

  it.each(PICTURES)('%s is small enough for a shop on one bar of signal', (file) => {
    // Whatever picture is put here has to meet the budget the first two met.
    expect(statSync(file).size).toBeLessThan(90 * 1024);
  });

  it('gives the doors that belong to one business the shopfront', () => {
    for (const path of [
      ['app', 'page.tsx'],
      ['app', 'find-shop', 'page.tsx'],
      ['app', '[slug]', 'page.tsx'],
      ['app', '[slug]', 'pos', 'page.tsx'],
    ]) {
      expect(web(...path)).toContain('picture="shopfront"');
    }
  });

  it('paints its own colour under the picture, so a slow door is never a white flash', () => {
    expect(door).toMatch(/bg-\[#[0-9a-f]{6}\]/);
  });

  it('keeps a scrim, so the line under the card is readable on the picture', () => {
    expect(door).toContain('text-white/80');
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
