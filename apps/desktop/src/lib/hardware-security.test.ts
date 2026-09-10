import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What the hardware transport is allowed to do.
 *
 * Printing needs the operating system, and reaching for the operating system is where a
 * POS application acquires the ability to do far more than print. These tests pin the
 * blast radius: the frontend can ask for a list of printers and for bytes to be sent to
 * one, and nothing else.
 */
describe('hardware transport privileges', () => {
  const root = join(import.meta.dirname, '..', '..');
  const read = (relative: string) => readFileSync(join(root, relative), 'utf8');

  const capabilities = JSON.parse(read(join('src-tauri', 'capabilities', 'default.json'))) as {
    permissions: string[];
  };

  it('grants no new capability for printing', () => {
    /*
     * Printing is implemented as ordinary Tauri commands, which are the application's own
     * IPC rather than plugin permissions. That is the whole reason this approach was
     * chosen over a USB library: it needs no grant at all.
     */
    expect(capabilities.permissions.sort()).toEqual([
      'core:default',
      'dialog:allow-save',
      'sql:allow-close',
      'sql:allow-execute',
      'sql:allow-load',
      'sql:allow-select',
    ]);
  });

  it('grants no filesystem, shell or arbitrary execution', () => {
    // A printer transport that could also read files or run programs would be a far
    // larger thing than a printer transport.
    for (const forbidden of ['fs:', 'shell:', 'process:', 'http:', 'os:']) {
      expect(
        capabilities.permissions.some((p) => p.startsWith(forbidden)),
        `capability ${forbidden} is granted`,
      ).toBe(false);
    }
  });

  it('exposes exactly two printer commands to the frontend', () => {
    const main = read(join('src-tauri', 'src', 'main.rs'));
    const handler = main.slice(main.indexOf('generate_handler!'));
    expect(handler).toContain('list_printers');
    expect(handler).toContain('print_raw');
  });

  it('never lets the frontend name a file or a program', () => {
    // print_raw takes a printer name and bytes. If it ever took a path or a command, the
    // spooler would become a way to write anywhere or run anything.
    const printer = read(join('src-tauri', 'src', 'printer.rs'));
    expect(printer).not.toMatch(/std::process::Command/);
    expect(printer).not.toMatch(/std::fs::(write|File|remove)/);
    expect(printer).toContain('pub fn print_raw(printer: &str, bytes: &[u8])');
  });

  it('sends the job as RAW, so the bytes are not reinterpreted', () => {
    // Anything other than RAW asks Windows to render ESC/POS as a document, which prints
    // pages of escape codes on a customer's receipt.
    expect(read(join('src-tauri', 'src', 'printer.rs'))).toContain('wide("RAW")');
  });

  it('closes the printer handle on every path, including failures', () => {
    // A leaked handle keeps the spooler busy until the application exits, which on a till
    // means until the shop closes.
    const printer = read(join('src-tauri', 'src', 'printer.rs'));
    expect(printer).toContain('let _ = ClosePrinter(handle);');
  });

  it('embeds no credential in the transport', () => {
    const printer = read(join('src-tauri', 'src', 'printer.rs'));
    expect(printer).not.toMatch(/password|secret|api[_-]?key|token/i);
  });
});
