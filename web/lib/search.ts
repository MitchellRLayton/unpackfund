/**
 * Ranked search over the two things a reader can jump to: a fund and a company.
 *
 * The ranking is a fixed ladder rather than a fuzzy score, because the two
 * mistakes are not symmetric: a reader who types `VTI` and gets Vanguard Total
 * Stock Market ETF first is served, and a reader who types `VTI` and gets
 * "Vanguard Total International Bond ETF" first has to read the list to find out
 * why. So an exact ticker beats a ticker prefix, which beats a name that starts
 * with the query, which beats a name that contains it, which beats an issuer
 * match. Ties break alphabetically, so the same query always produces the same
 * order.
 *
 * Nothing here is a recommendation: the list is ordered by how well it matches
 * what was typed, never by size, return, or popularity.
 */

import type { Catalogue, CompanyIndex } from "./types";

export type HitKind = "fund" | "company";

export interface SearchHit {
  kind: HitKind;
  /** The fund ticker, or the company id. */
  id: string;
  /** The line the reader reads first: `VTI`, or the company's name. */
  label: string;
  /** The second line: the fund's name, or the company's ticker and fund count. */
  detail: string;
  /** Where Enter goes. */
  href: string;
  score: number;
}

const EXACT_TICKER = 1000;
const TICKER_PREFIX = 800;
const NAME_PREFIX = 600;
const NAME_WORD = 500;
const NAME_CONTAINS = 400;
const ISSUER_CONTAINS = 200;

function normalise(value: string): string {
  return value.trim().toLowerCase();
}

/** Score one candidate against a normalised query. `0` means "no match". */
function score(query: string, ticker: string | null, name: string, issuer = ""): number {
  const t = ticker ? ticker.toLowerCase() : "";
  const n = name.toLowerCase();
  const i = issuer.toLowerCase();

  if (t && t === query) return EXACT_TICKER;
  if (t && t.startsWith(query)) return TICKER_PREFIX;
  if (n.startsWith(query)) return NAME_PREFIX;
  if (n.split(/[^a-z0-9]+/).some((word) => word.startsWith(query))) return NAME_WORD;
  if (n.includes(query)) return NAME_CONTAINS;
  if (i && i.includes(query)) return ISSUER_CONTAINS;
  return 0;
}

export function rankFunds(
  query: string,
  catalogue: Catalogue | null,
  limit = 6,
): SearchHit[] {
  const q = normalise(query);
  if (!catalogue || q.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const [ticker, row] of Object.entries(catalogue.funds)) {
    const [name, issuer] = row;
    const score_ = score(q, ticker, name, issuer);
    if (score_ === 0) continue;
    hits.push({
      kind: "fund",
      id: ticker,
      label: ticker,
      detail: `${name} · ${issuer}`,
      href: `/f/${ticker}/`,
      score: score_,
    });
  }
  return sortHits(hits).slice(0, limit);
}

export function rankCompanies(
  query: string,
  index: CompanyIndex | null,
  limit = 6,
): SearchHit[] {
  const q = normalise(query);
  if (!index || q.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const [id, name, ticker, holderCount] of index.companies) {
    const score_ = score(q, ticker, name);
    if (score_ === 0) continue;
    hits.push({
      kind: "company",
      id,
      label: name,
      detail: `${ticker ? `${ticker} · ` : ""}held by ${holderCount.toLocaleString("en-US")} ${
        holderCount === 1 ? "fund" : "funds"
      }`,
      href: `/c/#${id}`,
      score: score_,
    });
  }
  return sortHits(hits).slice(0, limit);
}

function sortHits(hits: SearchHit[]): SearchHit[] {
  return hits.sort(
    (a, b) =>
      b.score - a.score ||
      (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) ||
      (a.id < b.id ? -1 : 1),
  );
}

/**
 * Both kinds in one list, funds first on a tie.
 *
 * A ticker is the more specific thing to type, so when a query matches a fund's
 * ticker exactly and a company's name loosely, the fund is the better answer.
 */
export function searchAll(
  query: string,
  sources: { catalogue: Catalogue | null; companies: CompanyIndex | null },
  limit = 8,
): SearchHit[] {
  const funds = rankFunds(query, sources.catalogue, limit);
  const companies = rankCompanies(query, sources.companies, limit);
  return sortHits([...funds, ...companies]).slice(0, limit);
}
