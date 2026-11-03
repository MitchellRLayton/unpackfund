/**
 * The `/funds/` directory's pure part: rows in, rows out.
 *
 * Kept out of the component because ordering is the thing that can be wrong — an
 * exact ticker must beat a prefix match, a prefix must beat a substring in an
 * issuer name — and that is testable without a browser.
 *
 * Three rules live here.
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
 * **The order opens on size when the release carries it.** The catalogue's fifth
 * element is the fund's own filed N-PORT net assets, and `/funds` should open on the
 * largest funds rather than an editorial list (operator's instruction, 2026-11-02).
 * `assets` sorts by that figure descending and puts funds without one after the
 * funds that have one, in ticker order — a fund whose filing reported no net assets
 * has no size answer, and treating it as `$0` would sort it beside a genuinely empty
 * fund. `DEFAULT_SORT` is `assets`; `defaultSort` falls back to `popular` when no row
 * carries a figure, because the live release (`2026-11-02.7`) predates the field and
 * a page that claimed "largest by assets" while sorting by ticker would be a lie
 * with nothing behind it. `popular` (the curated widely held funds first, see
 * `popular.ts`) and `alpha` (plain A–Z) stay for a reader who asks. A sort can only
 * reorder rows it is given, so a curated ticker the release does not publish never
 * appears.
 *
 * **Names are display text, not filing text.** Rows carry `displayName(name)` and
 * `displayName(issuer)`, so a caps-cased trust and a mixed-case one read as one list
 * (the rules and their exceptions live in `provider-name.ts`). The transform happens
 * here rather than in the component so search and display cannot disagree: the
 * search compares upper-cased display text, which is the same string the reader sees.
 */

import { popularRank } from "./popular";
import { displayName } from "./provider-name";
import type { CatalogueRow } from "./types";

/** Coverage below the contract's partial band is shown as a dash, not a number. */
export const PARTIAL_COVERAGE = 60;

export interface DirectoryRow {
  ticker: string;
  name: string;
  issuer: string;
  coverage: number;
  /**
   * The fund's own filed N-PORT net assets in whole dollars, or `null` when the
   * release carries none: a four-element catalogue row (a release built before
   * 2026-11-02) and a filing that reports no net assets both arrive as `null`, and
   * the sort treats them the same because neither is a size answer.
   */
  netAssets: number | null;
}

/**
 * One positional catalogue row — `types.CatalogueRow`, named again here because this
 * module's own tests construct rows by hand and the name says what they are.
 *
 * There is one definition, not two: `toRows` reads the row's length rather than trusting
 * a version number, which is the same additive-contract rule the pipeline's validator
 * applies to the same rows, so a four-element row from an older release still lists.
 */
export type CatalogueTuple = CatalogueRow;

/** Catalogue rows → directory rows, in ticker order and case-normalised for display. */
export function toRows(funds: Record<string, CatalogueTuple>): DirectoryRow[] {
  return Object.entries(funds)
    .map(([ticker, [name, issuer, , coverage, netAssets]]) => ({
      ticker,
      name: displayName(name),
      issuer: displayName(issuer),
      coverage,
      netAssets: netAssets ?? null,
    }))
    .sort(byTicker);
}

/** `assets` = largest filed net assets first; `popular` = curated; `alpha` = A–Z. */
export type DirectorySort = "assets" | "popular" | "alpha";

/** The order a release that carries size figures opens on. */
export const DEFAULT_SORT: DirectorySort = "assets";

/**
 * The order the directory opens in for these rows.
 *
 * Size when at least one row carries a filed figure, otherwise `popular` — the order
 * the page shipped with before the figure existed. The condition is deliberately
 * "at least one", not "all": a release where a few filings report no net assets is
 * still a size-ranked release (those funds sort after the ones with a figure), and
 * only a release with no figures at all has nothing to rank, which is the live
 * `2026-11-02.7` case the component explains in words.
 */
export function defaultSort(rows: DirectoryRow[]): DirectorySort {
  return rows.some((row) => row.netAssets !== null) ? DEFAULT_SORT : "popular";
}

function byTicker(a: DirectoryRow, b: DirectoryRow): number {
  return a.ticker.localeCompare(b.ticker);
}

/**
 * Order rows for display. Never drops or adds one.
 *
 * `assets` puts the largest filed net assets first and every fund without a figure
 * after every fund with one, in ticker order; equal figures fall back to ticker so a
 * release cannot reorder itself between two identical runs. `popular` puts the
 * curated tickers first in `POPULAR_ORDER` order; every other row keeps alphabetical
 * order after them. Two curated rows cannot share a rank, so the only tie that
 * reaches `byTicker` is two uncurated rows — which is exactly the alphabetical tail.
 * `alpha` is plain ticker order. Deterministic given the same rows.
 *
 * The default is `defaultSort(rows)`, not a bare `DEFAULT_SORT`, so a call that omits
 * the argument on an assetless release still opens in the editorial order rather than
 * silently becoming A–Z.
 */
export function sortRows(
  rows: DirectoryRow[],
  sort: DirectorySort = defaultSort(rows),
): DirectoryRow[] {
  if (sort === "alpha") return [...rows].sort(byTicker);
  if (sort === "assets") {
    return [...rows].sort((a, b) => {
      if (a.netAssets === null && b.netAssets === null) return byTicker(a, b);
      // A missing figure is not a small one: it sorts after every known answer.
      if (a.netAssets === null) return 1;
      if (b.netAssets === null) return -1;
      if (a.netAssets !== b.netAssets) return b.netAssets - a.netAssets;
      return byTicker(a, b);
    });
  }
  return [...rows].sort((a, b) => {
    const left = popularRank(a.ticker);
    const right = popularRank(b.ticker);
    if (left < right) return -1;
    if (left > right) return 1;
    return byTicker(a, b);
  });
}

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

/**
 * Rows a query matches, best first.
 *
 * One word keeps the original ranking: exact ticker, then ticker or name prefix,
 * then a substring of the name or issuer. Several words are AND-ed — a row has to
 * match every one — and rows whose *name* carries all the words come first,
 * because `avantis etf` is a fund-type question and a fund's type is written in
 * its name. Ties keep the order they arrived in.
 */
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
