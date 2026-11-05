/**
 * Rows for the two company surfaces, as pure functions.
 *
 * The companies directory and the company page read three different release
 * objects — `companies/index.json` for the list, `companies/countries.json` for a
 * domicile, `companies/{id}.json` for the fund table — and the arithmetic that
 * joins them lives here so both surfaces (and their tests) use one implementation.
 *
 * Two rules carried over from the ledger, because a company page and a portfolio
 * page must not disagree about the same company:
 *
 * - **Names and tickers are printed as filed.** No title-casing: the ledger shows
 *   `AAR CORP` and this page shows `AAR CORP`.
 * - **Ordering is a view, never a score.** The default list order is the company's
 *   name; the fund table inside a company is ordered by the fund's weight in that
 *   company, largest first — the filing's own number, not a ranking of funds.
 */

import { DEFAULT_PROVIDER, type CountryTier, type Provider } from "@/lib/country-tier";
import { PROVIDER_SHORT } from "@/components/lenses/lens-math";
import { displayName } from "@/lib/provider-name";
import type {
  Catalogue,
  CompanyIndex,
  CompanyIndexRow,
  CompanyShard,
  Ledger,
} from "@/lib/types";

export interface CompanyRow {
  id: string;
  name: string;
  ticker: string | null;
  /** How many funds in the release hold it. */
  holders: number;
  /** ISO-3166-1 alpha-2, or `null` when the release has no answer for it. */
  country: string | null;
}

/**
 * Index rows → display rows, joined to the release's country map.
 *
 * `countries` is `null` until it has loaded, and the join then yields `null` for
 * every row rather than a default: a page that has not read the map has not
 * earned an opinion about where a company is domiciled.
 */
export function toCompanyRows(
  index: CompanyIndex | null,
  countries: Record<string, string> | null,
): CompanyRow[] {
  if (!index) return [];
  return index.companies.map(([id, name, ticker, holders]: CompanyIndexRow) => ({
    id,
    name,
    ticker,
    holders,
    country: countries ? (countries[id] ?? null) : null,
  }));
}

export type CompanyOrderKey = "name" | "ticker" | "country" | "holders";

export type CompanyDirection = "ascending" | "descending";

export type CompanyOrder =
  { key: "match" } | { key: CompanyOrderKey; direction: CompanyDirection };

/** The list opens alphabetically: a directory's default is "where would it be". */
export const DEFAULT_COMPANY_ORDER: CompanyOrder = {
  key: "name",
  direction: "ascending",
};

export const COMPANY_COLUMN_LABELS: Record<CompanyOrderKey, string> = {
  name: "Company",
  ticker: "Ticker",
  country: "Domicile",
  holders: "Held by",
};

function compareText(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

function byId(a: CompanyRow, b: CompanyRow): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compare(a: CompanyRow, b: CompanyRow, key: CompanyOrderKey): number {
  switch (key) {
    case "ticker":
      // A company with no listed ticker sorts after the ones that have one, in
      // both directions: "no ticker" is not a value between "A" and "B".
      if (a.ticker === null && b.ticker === null) return compareText(a.name, b.name);
      if (a.ticker === null) return 1;
      if (b.ticker === null) return -1;
      return compareText(a.ticker, b.ticker);
    case "country":
      if (a.country === null && b.country === null) return compareText(a.name, b.name);
      if (a.country === null) return 1;
      if (b.country === null) return -1;
      return compareText(a.country, b.country) || compareText(a.name, b.name);
    case "holders":
      return a.holders - b.holders || compareText(a.name, b.name);
    case "name":
    default:
      return compareText(a.name, b.name);
  }
}

/**
 * Where a row with no value for this column belongs: after every row that has one.
 *
 * This is compared *before* the direction is applied, because "no ticker" and "no
 * country" are not values that sort between "A" and "B" — reversing the list must
 * not move the unanswered rows to the top, where they would read as the first
 * answer.
 */
function missingRank(row: CompanyRow, key: CompanyOrderKey): number {
  if (key === "ticker") return row.ticker === null ? 1 : 0;
  if (key === "country") return row.country === null ? 1 : 0;
  return 0;
}

/** Rows in the asked-for order. Pure: the input is never mutated. */
export function orderCompanyRows(rows: CompanyRow[], order: CompanyOrder): CompanyRow[] {
  // "Closest match" is the order the search produced; there is nothing to sort.
  if (order.key === "match") return [...rows];
  const sign = order.direction === "descending" ? -1 : 1;
  return [...rows].sort(
    (a, b) =>
      missingRank(a, order.key) - missingRank(b, order.key) ||
      sign * compare(a, b, order.key) ||
      byId(a, b),
  );
}

/**
 * What a header click asks for next: the same column flips, a new one starts in
 * its natural direction. "Held by" starts largest-first because a reader asking
 * that question is usually looking for the widely held names.
 */
export function nextCompanyOrder(
  current: CompanyOrder,
  key: CompanyOrderKey,
): CompanyOrder {
  if (current.key === key) {
    return {
      key,
      direction: current.direction === "ascending" ? "descending" : "ascending",
    };
  }
  return { key, direction: key === "holders" ? "descending" : "ascending" };
}

export function companyAriaSort(
  order: CompanyOrder,
  key: CompanyOrderKey,
): CompanyDirection | undefined {
  return order.key === key && "direction" in order ? order.direction : undefined;
}

export function companyOrderDescription(order: CompanyOrder): string {
  switch (order.key) {
    case "match":
      return "closest match first";
    case "holders":
      return order.direction === "descending"
        ? "by how many funds hold it, most first"
        : "by how many funds hold it, fewest first";
    case "ticker":
      return `by ticker, ${order.direction}`;
    case "country":
      return `by domicile, ${order.direction}`;
    case "name":
    default:
      return order.direction === "ascending"
        ? "by company name"
        : "by company name, reversed";
  }
}

/**
 * Rows matching a query, best first.
 *
 * A single word is ranked by `lib/search.ts`'s company ladder — exact ticker, then
 * ticker prefix, then name prefix, then a name word, then a name or issuer
 * substring — so the top result is the one a reader meant. Several words are
 * AND-ed over the name and ticker, which the single-needle ranker cannot score; the
 * matches then keep the name order they arrived in. This is a deliberate
 * improvement on the old single-substring rule, which made `alphabet inc` match
 * `ALPHABET INC.` but never `inc alphabet`.
 */
export function searchCompanyRows(rows: CompanyRow[], query: string): CompanyRow[] {
  const tokens = query
    .trim()
    .toUpperCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return rows;

  const matched = rows.filter((row) => {
    const own = `${row.ticker ?? ""} ${row.name.toUpperCase()}`;
    return tokens.every((token) => own.includes(token));
  });
  if (tokens.length > 1 || matched.length < 2) return matched;

  const [needle] = tokens;
  if (!needle) return matched;
  const byIdMap = new Map(matched.map((row) => [row.id, row]));
  const index: CompanyIndex = {
    as_of: "",
    companies: matched.map((row): CompanyIndexRow => [
      row.id,
      row.name,
      row.ticker,
      row.holders,
    ]),
  };
  const hits = rankCompaniesLocal(needle, index, matched.length);
  if (hits.length !== matched.length) return matched;
  return hits.flatMap((hit) => {
    const row = byIdMap.get(hit.id);
    return row ? [row] : [];
  });
}

/**
 * `rankCompanies` with the release's own index, kept behind a local name so this
 * module has one import to change if the ladder moves. It is the same function the
 * header search uses; there is no second ranker.
 */
function rankCompaniesLocal(
  query: string,
  index: CompanyIndex,
  limit: number,
): Array<{ id: string }> {
  return rankCompanies(query, index, limit);
}

import { rankCompanies } from "@/lib/search";

/** One row of a company's fund table: the fund, and the fund's weight in it. */
export interface CompanyFundRow {
  ticker: string;
  /** The fund's display name from the catalogue, or the ticker when unknown. */
  name: string;
  weightBp: number;
  /** The fund's coverage percentage, for the reader who wants to weight the number. */
  coverage: number | null;
}

/**
 * The funds that hold a company, largest position first.
 *
 * The weight is the fund's own filed basis points for this company, so the table is
 * ordered by how much of *that fund* the company is — which is the only comparison
 * these numbers support. A ticker the catalogue does not know still gets a row (the
 * shard is the authority on who holds it) with its ticker for a name.
 */
export function companyFundRows(
  shard: CompanyShard | null,
  catalogue: Catalogue | null,
): CompanyFundRow[] {
  if (!shard) return [];
  return shard.funds
    .map(([ticker, weightBp]): CompanyFundRow => {
      const row = catalogue ? catalogue.funds[ticker] : undefined;
      return {
        ticker,
        name: row ? displayName(row[0]) : ticker,
        weightBp,
        coverage: row ? row[3] : null,
      };
    })
    .sort(
      (a, b) =>
        b.weightBp - a.weightBp ||
        (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0),
    );
}

export interface HoldingLine {
  /** This company's share of the whole portfolio, as a fraction. */
  weight: number;
  /** How many funds in the portfolio hold it. */
  funds: number;
}

/**
 * "You hold X% through N funds", from the ledger the workspace already built.
 *
 * The ledger is the one place a portfolio's company weights are computed, with the
 * coverage bands and the direct positions applied; this reads one row out of it
 * rather than re-deriving a look-through. `null` when there is no ledger or the
 * company is not in it — a zero claimed by a page that did not compute it is worse
 * than a sentence that is simply absent.
 */
export function holdingLine(
  ledger: Ledger | null,
  companyId: string,
): HoldingLine | null {
  if (!ledger) return null;
  const row = ledger.rows.find((entry) => entry.company_id === companyId);
  if (!row || row.weight <= 0) return null;
  return { weight: row.weight, funds: row.holder_count };
}

/**
 * The domicile to print for a company: the shard's own answer when it has one, the
 * release's country map otherwise, `null` when neither does.
 */
export function companyCountry(
  shard: CompanyShard | null,
  id: string,
  countries: Record<string, string> | null,
): string | null {
  const fromShard = shard?.country ?? null;
  if (fromShard) return fromShard;
  return countries ? (countries[id] ?? null) : null;
}

/**
 * The words for a country's tier, for the company detail.
 *
 * The tier itself is `lib/country-tier.ts`'s — one classification, computed in one
 * place, with its own `as_of` — and this only spells it for a reader. The labels
 * are the same words the look-through legend uses, because a reader who meets a
 * country in a company page and the same company in their ledger should not have to
 * learn two names for one tier.
 */
const TIER_LABELS: Record<CountryTier, string> = {
  US: "United States",
  DM: "International Developed ex-US",
  EM: "Emerging Markets",
};

/**
 * The words for a tier, or `null` when the release has no country to classify.
 *
 * The convention is named beside the tier for the same reason the Markets bar names it:
 * "Emerging Markets" is a publisher's judgement, and Korea is emerging under one
 * convention and developed under the other.
 */
export function tierLabel(
  tier: CountryTier | null,
  provider: Provider = DEFAULT_PROVIDER,
): string | null {
  return tier === null ? null : `${TIER_LABELS[tier]} (${PROVIDER_SHORT[provider]})`;
}
