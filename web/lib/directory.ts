/**
 * The `/funds/` directory's pure part: rows in, rows out.
 *
 * Kept out of the component because ordering is the thing that can be wrong — an
 * exact ticker must beat a prefix match, a prefix must beat a substring in an
 * issuer name — and that is testable without a browser.
 *
 * Two rules live here.
 *
 * **Search is token-AND.** Every whitespace-separated word has to match the row
 * somewhere (ticker, name, or issuer), so `avantis etf` finds the Avantis ETFs and
 * `avantis fund` the Avantis mutual funds, for any issuer, with one rule a reader
 * can learn. It is deliberately *not* the catalogue's `etf` flag: that flag is a
 * name heuristic (`name_rule_v1`) which labels VOO — a share class of "VANGUARD
 * 500 INDEX FUND" — a mutual fund, so answering "ETF" from it would make the
 * search lie. Fund names carry the words, so matching the words is both simpler
 * and true. An issuer's wording counts for ordinary words, so `vanguard 500`
 * finds the three funds the trust's own name mentions — but **not for the type
 * words** (`etf`, `etfs`, `fund`, `funds`). Without that exception the Avantis
 * trust, which is literally "American Century ETF Trust", would answer `avantis
 * etf` with its mutual funds: a reader asking for ETFs and getting funds has been
 * told something false. Type words are answered by the fund's own name only.
 *
 * **The default order is `popular`** (see `popular.ts`): the curated widely held
 * funds first, then everything else alphabetically. `alpha` is the plain A–Z
 * switch. A sort can only reorder rows it is given, so a curated ticker the
 * release does not publish never appears.
 */

import { popularRank } from "./popular";

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
    .sort(byTicker);
}

/** `popular` = curated widely held funds first; `alpha` = plain ticker order. */
export type DirectorySort = "popular" | "alpha";

/** What the directory shows until the reader asks for A–Z. */
export const DEFAULT_SORT: DirectorySort = "popular";

function byTicker(a: DirectoryRow, b: DirectoryRow): number {
  return a.ticker.localeCompare(b.ticker);
}

/**
 * Order rows for display. Never drops or adds one.
 *
 * `popular` puts the curated tickers first in `POPULAR_ORDER` order; every other
 * row keeps alphabetical order after them. Two curated rows cannot share a rank,
 * so the only tie that reaches `byTicker` is two uncurated rows — which is exactly
 * the alphabetical tail. Deterministic given the same rows.
 */
export function sortRows(
  rows: DirectoryRow[],
  sort: DirectorySort = DEFAULT_SORT,
): DirectoryRow[] {
  if (sort === "alpha") return [...rows].sort(byTicker);
  return [...rows].sort((a, b) => {
    const left = popularRank(a.ticker);
    const right = popularRank(b.ticker);
    if (left < right) return -1;
    if (left > right) return 1;
    return byTicker(a, b);
  });
}

/**
 * Rows a query matches, best first.
 *
 * One word keeps the original ranking: exact ticker, then ticker or name prefix,
 * then a substring of the name or issuer. Several words are AND-ed — a row has to
 * match every one — and rows whose *name* carries all the words come first,
 * because `avantis etf` is a fund-type question and a fund's type is written in
 * its name. Ties keep the order they arrived in.
 */
/**
 * Words that name the wrapper rather than the strategy.
 *
 * `avantis etf` must not match a fund just because its *trust* is called
 * "American Century ETF Trust", so these are matched against the ticker and the
 * fund's own name only. A fund whose name says FUND is a fund; the trust's
 * paperwork cannot overrule that.
 */
const TYPE_TOKENS = new Set(["ETF", "FUND"]);

/** `etfs` and `funds` are the same question as `etf` and `fund`. */
function singularTypeWord(token: string): string {
  if (token === "ETFS") return "ETF";
  if (token === "FUNDS") return "FUND";
  return token;
}

export function filterRows(rows: DirectoryRow[], query: string): DirectoryRow[] {
  const tokens = query
    .trim()
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean)
    .map(singularTypeWord);
  const [needle] = tokens;
  if (!needle) return rows;

  if (tokens.length === 1) {
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

  const named: DirectoryRow[] = [];
  const rest: DirectoryRow[] = [];
  for (const row of rows) {
    const name = row.name.toUpperCase();
    // One space between fields, and no token can contain a space, so this
    // concatenation cannot manufacture a match across a field boundary.
    const own = `${row.ticker.toUpperCase()} ${name}`;
    const issuer = row.issuer.toUpperCase();
    const matchesEveryToken = tokens.every(
      (token) =>
        own.includes(token) || (!TYPE_TOKENS.has(token) && issuer.includes(token)),
    );
    if (!matchesEveryToken) continue;
    if (tokens.every((token) => name.includes(token))) named.push(row);
    else rest.push(row);
  }
  return [...named, ...rest];
}

/** A coverage figure we are willing to print, or null where a dash belongs. */
export function shownCoverage(coverage: number): string | null {
  return coverage >= PARTIAL_COVERAGE ? `${coverage.toFixed(1)}%` : null;
}
