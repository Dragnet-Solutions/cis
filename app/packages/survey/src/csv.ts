/**
 * CSV cells for every export the platform writes (BUG-06).
 *
 * A spreadsheet reads a cell that starts with = + - @ (or a tab or carriage
 * return, which some spreadsheets strip before looking) as a formula — so a
 * firm name, contact or note typed as `=HYPERLINK(...)` would run when an
 * operator opens the download. Such a cell is written with a leading
 * apostrophe, which the spreadsheet shows as plain text.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/** The value, made safe to open in a spreadsheet. */
export function neutraliseFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** One CSV cell: formula-safe, and quoted when it holds a comma, quote or line break. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const safe = typeof value === 'number' ? String(value) : neutraliseFormula(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One CSV row. */
export function csvRow(values: ReadonlyArray<string | number | null | undefined>): string {
  return values.map(csvCell).join(',');
}
