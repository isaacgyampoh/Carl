import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { csvCell, csvFilename, csvMoney, toCsv } from '../../apps/web/src/lib/csv';

/**
 * Handing a shop's figures to a spreadsheet.
 *
 * Every shop keeping books outside Carl was retyping totals off a screen. The export is the
 * same data the reports page shows — and, because a spreadsheet runs what looks like a formula,
 * exporting it safely is not a matter of joining strings with commas.
 */
describe('a cell', () => {
  it('quotes what would otherwise break the row', () => {
    expect(csvCell('Kofi, Accra')).toBe('"Kofi, Accra"');
    expect(csvCell('He said "yes"')).toBe('"He said ""yes"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('refuses to let a product name become a formula', () => {
    // The classic: a cell starting with = is executed when the shopkeeper opens their own export.
    expect(csvCell("=cmd|' /c calc'!A1")).toBe("'=cmd|' /c calc'!A1");
    for (const start of ['=', '+', '-', '@']) {
      expect(csvCell(`${start}danger`).startsWith("'")).toBe(true);
    }
  });

  it('leaves ordinary text and numbers alone', () => {
    expect(csvCell('Rice 5kg')).toBe('Rice 5kg');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
});

describe('a file', () => {
  it('opens correctly in Excel on Windows', () => {
    const csv = toCsv([{ name: 'Kofi' }], [{ header: 'Name', value: (row) => row.name }]);
    // A byte-order mark, or a cedi sign and every accented name arrives as mojibake.
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('\r\n');
  });

  it('writes money as a number a spreadsheet can total', () => {
    expect(csvMoney(12550)).toBe('125.50');
    expect(csvMoney(0)).toBe('0.00');
    expect(csvMoney(null)).toBe('0.00');
  });

  it('is named for what it holds and the days it covers', () => {
    expect(csvFilename('sales', '2026-09-01T00:00:00.000Z', '2026-09-08T00:00:00.000Z')).toBe(
      'carl-sales-2026-09-01-to-2026-09-08.csv',
    );
  });
});

describe('the export endpoint', () => {
  const route = readFileSync(
    join(
      import.meta.dirname,
      '..',
      '..',
      'apps',
      'web',
      'src',
      'app',
      '(app)',
      'reports',
      'export',
      'route.ts',
    ),
    'utf8',
  );

  it('reads as the caller, so it can return nothing they could not already see', () => {
    expect(route).toContain('const client = await supabase();');
    expect(route).not.toContain('serviceRoleClient');
    expect(route).toContain('hasPermission(auth, Permission.REPORTS_VIEW)');
  });

  it('treats a branch in the query string as a filter, never as a grant', () => {
    expect(route).toContain('auth.tenant.branches.some((branch) => branch.id === wantedBranch)');
  });

  it('accepts only the exports it offers', () => {
    expect(route).toContain("const KINDS = ['sales', 'payments', 'staff', 'products'] as const;");
  });

  it('sends the file as a download that no cache may keep', () => {
    expect(route).toContain('content-disposition');
    expect(route).toContain("'cache-control': 'no-store'");
  });
});

describe('the day report', () => {
  const page = readFileSync(
    join(
      import.meta.dirname,
      '..',
      '..',
      'apps',
      'web',
      'src',
      'app',
      '(app)',
      'reports',
      'day',
      'page.tsx',
    ),
    'utf8',
  );

  it('is a day of trading, closed off: sales, payments, drawers, spending and people', () => {
    expect(page).toContain("client.rpc('sales_summary', args)");
    expect(page).toContain("client.rpc('payment_method_breakdown', args)");
    expect(page).toContain("from('cash_sessions')");
    expect(page).toContain("client.rpc('staff_sales_summary', args)");
  });

  it('counts by when a sale was made, so a late sync does not change a closed day', () => {
    expect(page).toContain('p_from: from.toISOString()');
    expect(page).toContain('86_400_000');
  });

  it('can be printed, and hides its navigation when it is', () => {
    expect(page).toContain('<PrintButton');
    expect(page).toContain('print:hidden');
  });

  it('is reached from the reports page', () => {
    const reports = readFileSync(
      join(
        import.meta.dirname,
        '..',
        '..',
        'apps',
        'web',
        'src',
        'app',
        '(app)',
        'reports',
        'page.tsx',
      ),
      'utf8',
    );
    expect(reports).toContain('href="/reports/day"');
    expect(reports).toContain('/reports/export?type=');
  });
});
