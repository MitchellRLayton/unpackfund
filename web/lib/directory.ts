/**
 * The `/funds/` directory's pure part: rows in, rows out.
 *
 * Kept out of the component because ordering is the thing that can be wrong — an
 * exact ticker must beat a prefix match, and a prefix must beat a substring in an
 * issuer name — and that is testable without a browser.
 */

/** Coverage below the contract's partial band is shown as a dash, not a number. */
export const PARTIAL_COVERAGE = 60;

export interface DirectoryRow {
  ticker: string;
  name: string;
  issuer: string;
  coverage: number;
}

/** Catalogue rows (positional, `[name, issuer, etf, coverage]`) → directory rows. */
export function toRows(
  funds: Record<string, [name: string, issuer: string, etf: number, coverage: number]>,
): DirectoryRow[] {
  return Object.entries(funds)
    .map(([ticker, [name, issuer, , coverage]]) => ({
      ticker,
      name,
      issuer,
      coverage,
    }))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
}

/** Exact ticker first, then ticker/name prefix, then anything containing it. */
export function filterRows(rows: DirectoryRow[], query: string): DirectoryRow[] {
  const needle = query.trim().toUpperCase();
  if (!needle) return rows;
  const exact: DirectoryRow[] = [];
  const prefix: DirectoryRow[] = [];
  const contains: DirectoryRow[] = [];
  for (const row of rows) {
    const name = row.name.toUpperCase();
    const issuer = row.issuer.toUpperCase();
    if (row.ticker === needle) exact.push(row);
    else if (row.ticker.startsWith(needle) || name.startsWith(needle)) prefix.push(row);
    else if (name.includes(needle) || issuer.includes(needle)) contains.push(row);
  }
  return [...exact, ...prefix, ...contains];
}

/** A coverage figure we are willing to print, or null where a dash belongs. */
export function shownCoverage(coverage: number): string | null {
  return coverage >= PARTIAL_COVERAGE ? `${coverage.toFixed(1)}%` : null;
}
