/**
 * Comma-separated values, for a spreadsheet.
 *
 * ## Why the leading apostrophe
 *
 * A cell beginning with =, +, - or @ is a FORMULA to Excel, Numbers and Google Sheets. A
 * product called "=cmd|' /c calc'!A1" is a well-known way to make a shopkeeper's spreadsheet
 * run something when they open their own sales export. Prefixing those cells with an
 * apostrophe makes the spreadsheet show the text and run nothing — the same defence every
 * serious exporter applies, and the reason this is not a one-line join.
 *
 * Pure, so the escaping is tested on its own rather than through a download.
 */
export interface CsvColumn<Row> {
  readonly header: string;
  readonly value: (row: Row) => string | number | null | undefined;
}

const RISKY_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'number' ? String(value) : value;
  const guarded = RISKY_START.test(text) ? `'${text}` : text;
  // Quotes are doubled; anything holding a comma, a quote or a newline is quoted.
  return /[",\n\r]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

export function toCsv<Row>(rows: readonly Row[], columns: readonly CsvColumn<Row>[]): string {
  const header = columns.map((column) => csvCell(column.header)).join(',');
  const body = rows.map((row) => columns.map((column) => csvCell(column.value(row))).join(','));
  /*
   * CRLF and a UTF-8 byte-order mark: Excel on Windows opens a plain UTF-8 file as Windows-1252,
   * which turns a cedi sign and every accented name into mojibake on the shopkeeper's screen.
   */
  return `\uFEFF${[header, ...body].join('\r\n')}\r\n`;
}

/** Money as a spreadsheet can add it up: a plain decimal, no symbol, no thousands separator. */
export function csvMoney(minor: number | null | undefined): string {
  return ((minor ?? 0) / 100).toFixed(2);
}

/** A filename a shop can find again: what it is, and which days it covers. */
export function csvFilename(kind: string, from: string, to: string): string {
  const day = (iso: string) => iso.slice(0, 10);
  return `carl-${kind}-${day(from)}-to-${day(to)}.csv`;
}
