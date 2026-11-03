/**
 * The funds directory's search and two filters, as one pure function.
 *
 * Two rules are borrowed deliberately rather than reinvented:
 *
 * - **Matching** is `lib/directory.ts`'s `filterRows`: exact ticker first, then
 *   ticker prefix, then fund-name prefix, then a token-AND over the name and
 *   issuer, with `ETF`/`FUND` understood as type words. That is the rule the
 *   published directory already documents, and a second matcher would mean two
 *   answers to "why did this row not appear".
 * - **Ordering** is `lib/search.ts`'s `rankFunds` ladder, applied to the rows
 *   that matched. It scores one needle, so it only has an opinion on a
 *   single-word query; a multi-word query keeps the order `filterRows` produced.
 *   Neither is a popularity ranking: the list answers "did I spell it right".
 *
 * The coverage filter is the release's own 70/60 band (`format.coverageBand`),
 * never a second threshold, so "partial" here means the same thing as "partial"
 * on a fund page.
 */

import { filterRows, type DirectoryRow } from "@/lib/directory";
import { coverageBand } from "@/lib/format";
import { rankFunds } from "@/lib/search";
import type { Catalogue, CatalogueRow } from "@/lib/types";

/** The coverage bands a reader can ask for, plus "all". */
export type BandFilter = "all" | "full" | "partial" | "none";

export interface Filters {
  query: string;
  /** An exact issuer string, or `null` for every issuer. */
  issuer: string | null;
  band: BandFilter;
}

export const EMPTY_FILTERS: Filters = { query: "", issuer: null, band: "all" };

/** Is this row inside the asked-for band? `all` admits everything. */
export function matchesBand(coverage: number, band: BandFilter): boolean {
  return band === "all" || coverageBand(coverage) === band;
}

/**
 * Rows matching a query, best match first.
 *
 * `filterRows` already orders its matches by the same ladder `rankFunds` scores,
 * but it does not know the word-level prefix rule, so a fund whose *name* word
 * starts with the query can arrive after one that merely contains it. Re-ranking
 * with the shared ranker fixes that without a second implementation. When the
 * ranker does not score every matched row — a plural or type-word query it does
 * not normalise the same way — its ordering would silently drop rows, so the
 * `filterRows` order is kept instead. Both paths are exhaustive: no match is
 * ever lost, so the count the page announces is the count the reader gets.
 */
export function searchRows(rows: DirectoryRow[], query: string): DirectoryRow[] {
  const matched = filterRows(rows, query);
  const trimmed = query.trim();
  if (trimmed.length === 0 || matched.length < 2) return matched;
  if (/\s/.test(trimmed)) return matched;

  const byTicker = new Map(matched.map((row) => [row.ticker, row]));
  const catalogue: Catalogue = {
    as_of: "",
    funds: Object.fromEntries(
      matched.map((row): [string, CatalogueRow] => [
        row.ticker,
        [row.name, row.issuer, 0, row.coverage],
      ]),
    ),
  };
  const hits = rankFunds(trimmed, catalogue, matched.length);
  if (hits.length !== matched.length) return matched;
  return hits.flatMap((hit) => {
    const row = byTicker.get(hit.id);
    return row ? [row] : [];
  });
}

/** The rows the page shows: issuer and band first, then search. */
export function applyFilters(rows: DirectoryRow[], filters: Filters): DirectoryRow[] {
  const narrowed = rows.filter(
    (row) =>
      (filters.issuer === null || row.issuer === filters.issuer) &&
      matchesBand(row.coverage, filters.band),
  );
  return searchRows(narrowed, filters.query);
}

export interface IssuerOption {
  issuer: string;
  count: number;
}

/** Every issuer in the rows, alphabetically, with how many funds it has. */
export function issuerOptions(rows: DirectoryRow[]): IssuerOption[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.issuer, (counts.get(row.issuer) ?? 0) + 1);
  return [...counts.entries()]
    .map(([issuer, count]) => ({ issuer, count }))
    .sort((a, b) =>
      a.issuer.toLowerCase() < b.issuer.toLowerCase()
        ? -1
        : a.issuer.toLowerCase() > b.issuer.toLowerCase()
          ? 1
          : 0,
    );
}
