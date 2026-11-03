/**
 * The arithmetic the four lenses share.
 *
 * Every number a lens prints is computed here: pure functions with no React, no
 * DOM and no data loading, so the same number can be checked in a unit test
 * against arithmetic a human worked out by hand (`lookthrough-math-and-qa` §8 —
 * a hand-calculated fixture, never a snapshot of a previous run).
 *
 * Nothing here re-aggregates a fund. The ledger is the one aggregation
 * (`lib/aggregate.ts`); a fund's weight in a company arrives as a `LedgerSource`,
 * and these helpers add or divide those published numbers. That is what keeps the
 * Overlap lens and `/compare` answering with one definition (math §4: `Σ min`).
 *
 * Two deliberate exclusions, both stated where the number is printed:
 * - a **negative** company weight (a short inside a fund) is printed in the
 *   market split, because the split must add up to the ledger's resolved weight,
 *   but nothing is drawn for it — a bar is made of positive parts of a whole;
 * - a **cash or derivative** line has no company by definition, so it can never
 *   be a share of a company and never enters an overlap.
 */

import { tierOf, type CountryTier } from "@/lib/country-tier";
import { coverageBand, formatCoveragePct } from "@/lib/format";
import type {
  FundDocument,
  LedgerMetrics,
  LedgerRow,
  UnmappedBreakdown,
} from "@/lib/types";

/** The five segments the Markets bar can draw, in the order it draws them. */
export const MARKET_BUCKETS = ["US", "DM", "EM", "OTHER", "UNKNOWN"] as const;

/** `OTHER` is a known domicile with no market classification; `UNKNOWN` has no answer. */
export type MarketBucket = CountryTier | "UNKNOWN";

/** The segment's words. The legend and the table use the same string. */
export const BUCKET_WORD: Record<MarketBucket, string> = {
  US: "United States",
  DM: "Other developed markets",
  EM: "Emerging markets",
  OTHER: "No market tier",
  UNKNOWN: "No country answer",
};

/** The two-letter tier as words, for the country table's column. */
export const TIER_WORD: Record<CountryTier, string> = {
  US: "US",
  DM: "Developed",
  EM: "Emerging",
  OTHER: "No market tier",
};

/** The ten largest company lines, the same count the ledger's `top10` uses. */
export const TOP_COUNT = 10;

export type SortDirection = "ascending" | "descending";

export interface SortState<K extends string> {
  key: K;
  direction: SortDirection;
}

/**
 * What a click on a column header means: the first click sorts that column the
 * way its numbers are most useful (largest first), and a second click reverses it.
 */
export function nextSort<K extends string>(
  current: SortState<K>,
  key: K,
  firstDirection: SortDirection,
): SortState<K> {
  if (current.key !== key) return { key, direction: firstDirection };
  return {
    key,
    direction: current.direction === "descending" ? "ascending" : "descending",
  };
}

/**
 * Sort a copy, never the input. The comparator's tie-break is the caller's: two
 * funds at the same weight must not swap places between renders because their
 * order came out of a `Map`.
 */
export function sortBy<T, K extends string>(
  rows: readonly T[],
  sort: SortState<K>,
  compare: Record<K, (a: T, b: T) => number>,
): T[] {
  const factor = sort.direction === "ascending" ? 1 : -1;
  return [...rows].sort((a, b) => factor * compare[sort.key](a, b));
}

/* ------------------------------------------------------------------------- */
/* Markets                                                                   */
/* ------------------------------------------------------------------------- */

export interface MarketTierTotal {
  bucket: MarketBucket;
  /** Signed share of the whole portfolio: a short inside a fund is negative. */
  weight: number;
  companies: number;
}

export interface MarketCountryTotal {
  /** ISO-3166-1 alpha-2, or `null` when the release has no answer for any of them. */
  code: string | null;
  tier: CountryTier | null;
  /** Signed share of the whole portfolio. */
  weight: number;
  companies: number;
}

export interface UnplacedParts {
  /** Companies the release has no country for (`UNKNOWN`). */
  unknownCountry: number;
  /** Share positions inside funds that resolved to no company. */
  unmatchedSecurities: number;
  /** Cash and derivative lines inside funds: no company by definition. */
  unmatchedCashDerivatives: number;
  /** Cash the visitor entered: no company by definition. */
  cash: number;
  /**
   * Signed: Σ W_k · (filed total − 100%). A fund normally files slightly more than
   * its net assets (derivatives and liabilities sit outside the schedule), so this
   * is usually negative and it is what makes the parts close to 100%.
   */
  filedOvershoot: number;
  /** The dashed segment: every part above, added. */
  total: number;
  /** Companies inside `unknownCountry`. */
  unknownCompanies: number;
}

export interface MarketSplit {
  /** Four market tiers plus `UNKNOWN`, always all five, in drawing order. */
  tiers: MarketTierTotal[];
  /** One row per country code, largest first, with the no-answer row last. */
  countries: MarketCountryTotal[];
  /** Σ of every company line — the ledger's `metrics.resolved_weight`. */
  resolved: number;
  companies: number;
  /** True when a company line carries a negative weight (a short inside a fund). */
  hasNegative: boolean;
  /** What the bar cannot place, and its parts. */
  unplaced: UnplacedParts;
}

/**
 * The market split, from the ledger's company lines and the release's country map.
 *
 * `countryOf` is the model's lookup (`model.countryOf`), never a rule invented here:
 * the pipeline decides a domicile once, and a row's `country` is the same answer the
 * worker already had.
 */
export function marketSplit(input: {
  rows: LedgerRow[];
  countryOf: (companyId: string) => string | null;
  unmapped: UnmappedBreakdown;
  metrics: LedgerMetrics;
  funds: FundDocument[];
  weights: Record<string, number>;
}): MarketSplit {
  const tierTotals = new Map<MarketBucket, MarketTierTotal>();
  for (const bucket of MARKET_BUCKETS) {
    tierTotals.set(bucket, { bucket, weight: 0, companies: 0 });
  }

  const countryTotals = new Map<string, MarketCountryTotal>();
  let resolved = 0;
  let companies = 0;
  let hasNegative = false;

  for (const row of input.rows) {
    const code = input.countryOf(row.company_id) ?? row.country;
    const bucket: MarketBucket = code ? tierOf(code) : "UNKNOWN";

    const tier = tierTotals.get(bucket);
    if (tier) {
      tier.weight += row.weight;
      tier.companies += 1;
    }

    const key = code ?? "";
    const country = countryTotals.get(key);
    if (country) {
      country.weight += row.weight;
      country.companies += 1;
    } else {
      countryTotals.set(key, {
        code,
        tier: code ? tierOf(code) : null,
        weight: row.weight,
        companies: 1,
      });
    }

    resolved += row.weight;
    companies += 1;
    if (row.weight < 0) hasNegative = true;
  }

  const countries = [...countryTotals.values()].sort(
    (left, right) =>
      right.weight - left.weight ||
      (left.code ?? "\uffff").localeCompare(right.code ?? "\uffff"),
  );

  const tiers = MARKET_BUCKETS.map(
    (bucket) => tierTotals.get(bucket) ?? { bucket, weight: 0, companies: 0 },
  );

  return {
    tiers,
    countries,
    resolved,
    companies,
    hasNegative,
    unplaced: unplacedParts({
      rows: input.rows,
      countryOf: input.countryOf,
      unmapped: input.unmapped,
      metrics: input.metrics,
      funds: input.funds,
      weights: input.weights,
    }),
  };
}

/**
 * The part of the portfolio the bar draws as one dashed segment.
 *
 * The brief's definition is the first two terms — companies with no country answer,
 * plus weight that resolved to no company. Cash and the filed-weight correction are
 * added because the bar is of *your money*: leaving them out would make the segments
 * add to less than 100% and the missing part would be unexplained. Every term is
 * printed beside the bar, so nothing here is absorbed silently.
 */
export function unplacedParts(input: {
  rows: LedgerRow[];
  countryOf: (companyId: string) => string | null;
  unmapped: UnmappedBreakdown;
  metrics: LedgerMetrics;
  funds: FundDocument[];
  weights: Record<string, number>;
}): UnplacedParts {
  let unknownCountry = 0;
  let unknownCompanies = 0;
  for (const row of input.rows) {
    const code = input.countryOf(row.company_id) ?? row.country;
    if (!code) {
      unknownCountry += row.weight;
      unknownCompanies += 1;
    }
  }

  const unmatchedSecurities = input.unmapped.securities_weight;
  const unmatchedCashDerivatives = input.unmapped.cash_and_derivatives_weight;
  const cash = input.metrics.cash_weight;
  // Signed: a fund that files 100.04% of its NAV by mistake is corrected here rather
  // than absorbed into the company lines, so the parts still close to 100%.
  const overshoot = filedOvershoot(input.funds, input.weights);

  return {
    unknownCountry,
    unknownCompanies,
    unmatchedSecurities,
    unmatchedCashDerivatives,
    cash,
    filedOvershoot: overshoot,
    total:
      unknownCountry + unmatchedSecurities + unmatchedCashDerivatives + cash - overshoot,
  };
}

/** Σ W_k · (filed total − 100%), as a fraction of the portfolio. */
export function filedOvershoot(
  funds: readonly FundDocument[],
  weights: Record<string, number>,
): number {
  let overshoot = 0;
  for (const fund of funds) {
    const weight = weights[fund.ticker] ?? 0;
    if (weight <= 0) continue;
    let filedBp = 0;
    for (const holding of fund.holdings) filedBp += holding.weight_bp;
    overshoot += weight * (filedBp / 10_000 - 1);
  }
  return overshoot;
}

/**
 * The whole portfolio, reconciled: every term the Quality lens prints, and the
 * total they must add to. A total that is not 100% is a fact the reader is owed
 * rather than a number this function should hide.
 */
export interface UntracedTotals {
  resolved: number;
  unmatchedSecurities: number;
  unmatchedCashDerivatives: number;
  cash: number;
  /** Weight the visitor has not entered. Zero behind the lens gate, printed if not. */
  unallocated: number;
  filedOvershoot: number;
  total: number;
}

export function untracedTotals(input: {
  metrics: LedgerMetrics;
  unmapped: UnmappedBreakdown;
  funds: readonly FundDocument[];
  weights: Record<string, number>;
}): UntracedTotals {
  const filed = filedOvershoot(input.funds, input.weights);
  const total =
    input.metrics.resolved_weight +
    input.unmapped.securities_weight +
    input.unmapped.cash_and_derivatives_weight +
    input.metrics.cash_weight +
    input.metrics.unallocated_weight -
    filed;
  return {
    resolved: input.metrics.resolved_weight,
    unmatchedSecurities: input.unmapped.securities_weight,
    unmatchedCashDerivatives: input.unmapped.cash_and_derivatives_weight,
    cash: input.metrics.cash_weight,
    unallocated: input.metrics.unallocated_weight,
    filedOvershoot: filed,
    total,
  };
}

/* ------------------------------------------------------------------------- */
/* Top ten                                                                   */
/* ------------------------------------------------------------------------- */

export interface Top10Attribution {
  /** The ten largest company lines, largest first. */
  rows: LedgerRow[];
  /** Σ of those rows' portfolio weights: the ledger's `metrics.top10`. */
  total: number;
  /** Fund ticker → the portfolio weight it supplies inside those ten. */
  byFund: Map<string, number>;
  /** The visitor's own direct positions inside those ten. */
  direct: number;
}

/**
 * Which fund each part of your ten largest companies came through.
 *
 * The order is the aggregate's own: positive weights only, largest first, ties by
 * `company_id`, so the ten rows here are the ten rows behind `metrics.top10` and
 * `total` can be checked against it.
 */
export function top10Attribution(
  rows: readonly LedgerRow[],
  count = TOP_COUNT,
): Top10Attribution {
  const top = rows
    .filter((row) => row.weight > 0)
    .sort(
      (left, right) =>
        right.weight - left.weight || (left.company_id < right.company_id ? -1 : 1),
    )
    .slice(0, count);

  const byFund = new Map<string, number>();
  let direct = 0;
  let total = 0;

  for (const row of top) {
    total += row.weight;
    for (const source of row.sources) {
      if (source.kind === "security") {
        direct += source.weight;
        continue;
      }
      byFund.set(source.ref, (byFund.get(source.ref) ?? 0) + source.weight);
    }
  }

  return { rows: top, total, byFund, direct };
}

/* ------------------------------------------------------------------------- */
/* Overlap                                                                   */
/* ------------------------------------------------------------------------- */

export interface FundPairOverlap {
  a: string;
  b: string;
  /**
   * `Σ min(w_A, w_B)` over companies, where `w` is a share of that fund's own
   * portfolio — the definition `/compare` uses (math §4). A share of a fund, not of
   * the visitor's money.
   */
  overlap: number;
  /** `Σ max(0, w_A − w_B)`: the part of A the B does not hold. */
  onlyA: number;
  /** `Σ max(0, w_B − w_A)`: the part of B the A does not hold. */
  onlyB: number;
  /** Companies both funds hold with positive weight. */
  sharedCompanies: number;
  /** Companies either fund holds: the union the two are compared over. */
  unionCompanies: number;
  /** Σ w_A: the share of A's portfolio that resolved to a company. */
  resolvedA: number;
  resolvedB: number;
  /** Portfolio weight of each fund, so the reader can size the pair. */
  weightA: number;
  weightB: number;
}

/**
 * Every pair of funds in the mix, from the ledger's per-fund sources.
 *
 * The ledger already holds each fund's contribution to each company as
 * `W_k · w_{i,k}`. Dividing that by the fund's own portfolio weight `W_k` recovers
 * `w_{i,k}` — the fund's share of its own NAV — which is the quantity §4's
 * definition is written in. Nothing is re-aggregated, and nothing is normalised by
 * anything but the fund's own weight.
 *
 * A non-positive source (a short) is left out: a short is not a share of the same
 * companies, and `min` of a negative weight is not an overlap.
 */
export function pairwiseOverlap(input: {
  rows: readonly LedgerRow[];
  weights: Record<string, number>;
  tickers: readonly string[];
}): FundPairOverlap[] {
  const shares = new Map<string, Map<string, number>>();
  for (const ticker of input.tickers) {
    if ((input.weights[ticker] ?? 0) > 0) shares.set(ticker, new Map());
  }

  for (const row of input.rows) {
    for (const source of row.sources) {
      if (source.kind !== "fund" || source.weight <= 0) continue;
      const fund = shares.get(source.ref);
      const weight = input.weights[source.ref] ?? 0;
      if (!fund || weight <= 0) continue;
      fund.set(row.company_id, (fund.get(row.company_id) ?? 0) + source.weight / weight);
    }
  }

  const resolved = new Map<string, number>();
  for (const [ticker, fundShares] of shares) {
    let total = 0;
    for (const share of fundShares.values()) total += share;
    resolved.set(ticker, total);
  }

  const listed = input.tickers.filter(
    (ticker) => ticker !== undefined && shares.has(ticker),
  );

  const pairs: FundPairOverlap[] = [];
  for (let index = 0; index < listed.length; index += 1) {
    const a = listed[index];
    if (a === undefined) continue;
    const sharesA = shares.get(a);
    if (!sharesA) continue;
    for (let other = index + 1; other < listed.length; other += 1) {
      const b = listed[other];
      if (b === undefined) continue;
      const sharesB = shares.get(b);
      if (!sharesB) continue;

      let overlap = 0;
      let onlyA = 0;
      let onlyB = 0;
      let sharedCompanies = 0;
      let unionCompanies = 0;

      // Both sides are accumulated in the same pass: a company A holds 3% of and B
      // holds 5% of contributes to B's exclusive share, and a second loop over the
      // union would have to re-derive it. `overlap + onlyA` is A's resolved weight
      // and `overlap + onlyB` is B's, whatever the two funds hold.
      for (const [company, shareA] of sharesA) {
        const shareB = sharesB.get(company) ?? 0;
        unionCompanies += 1;
        overlap += Math.min(shareA, shareB);
        onlyA += Math.max(0, shareA - shareB);
        onlyB += Math.max(0, shareB - shareA);
        if (shareB > 0) sharedCompanies += 1;
      }
      for (const [company, shareB] of sharesB) {
        if (sharesA.has(company)) continue;
        unionCompanies += 1;
        onlyB += shareB;
      }

      pairs.push({
        a,
        b,
        overlap,
        onlyA,
        onlyB,
        sharedCompanies,
        unionCompanies,
        resolvedA: resolved.get(a) ?? 0,
        resolvedB: resolved.get(b) ?? 0,
        weightA: input.weights[a] ?? 0,
        weightB: input.weights[b] ?? 0,
      });
    }
  }

  return pairs.sort(
    (left, right) =>
      right.overlap - left.overlap ||
      (left.a === right.a ? 0 : left.a < right.a ? -1 : 1) ||
      (left.b < right.b ? -1 : 1),
  );
}

/**
 * What a pair's coverage allows the lens to say about its overlap.
 *
 * One rule for the whole site: 70% and above prints plainly, 60% up to but not
 * including 70% prints with a qualifier, below 60% withholds. The qualifier is not a
 * hedge — it is the direction of the error. A fund's untraced weight can only *hide*
 * holdings the two funds share, because every term of `Σ min(w_A, w_B)` is
 * non-negative and a position that resolved to no company contributes nothing. So
 * the computed overlap is always at or below the true one: a floor, in every band.
 * What changes with the band is how far below it can be — up to 30 points of the fund
 * in the full band, up to 40 in the partial one — and a number that can be 40 points
 * low has to say so or it reads as a fact.
 */
export type PairState = "printed" | "floor" | "withheld";

export interface PairVerdict {
  state: PairState;
  /** The sentence that qualifies or withholds the numbers, or `null` when plain. */
  note: string | null;
}

export interface PairCoverage {
  ticker: string;
  /** The fund's `coverage_pct`, or `null` when no filing answered. */
  coveragePct: number | null;
}

/** One pair's verdict, in the bands' own words. */
export function pairVerdict(a: PairCoverage, b: PairCoverage): PairVerdict {
  const funds = [a, b];

  const unknown = funds
    .filter((fund) => fund.coveragePct === null)
    .map((fund) => fund.ticker);
  if (unknown.length > 0) {
    return {
      state: "withheld",
      note: `${unknown.join(" and ")} ${unknown.length === 1 ? "has" : "have"} no coverage figure, so this pair cannot be compared.`,
    };
  }

  const below = funds
    .filter((fund) => coverageBand(fund.coveragePct ?? 0) === "none")
    .map(
      (fund) => `${fund.ticker} is ${formatCoveragePct(fund.coveragePct ?? 0)} covered`,
    );
  if (below.length > 0) {
    // Naming the fund and its percentage is the whole reason: the row says "not
    // computed" and this says which fund took it out. The caption states the rule.
    return {
      state: "withheld",
      note:
        below.length === 1
          ? `${below[0]}, below the 60% floor.`
          : `${below.join(" and ")}, below the 60% floor.`,
    };
  }

  const partial = funds
    .filter((fund) => coverageBand(fund.coveragePct ?? 0) === "partial")
    .map(
      (fund) => `${fund.ticker} is ${formatCoveragePct(fund.coveragePct ?? 0)} covered`,
    );
  if (partial.length > 0) {
    return {
      state: "floor",
      // The brief's sentence, and the whole of it: the reasoning is the lede's and the
      // caption's job, so the row stays short enough to sit in a table cell and the
      // answer strip can print the same words.
      note: `${partial.join(" and ")}, so this overlap is a floor.`,
    };
  }

  return { state: "printed", note: null };
}

/* ------------------------------------------------------------------------- */
/* Funds                                                                     */
/* ------------------------------------------------------------------------- */

export interface FundMixRow {
  ticker: string;
  name: string | null;
  /** Share of the whole portfolio. */
  weight: number;
  /** Positions in the fund's own filing, resolved and unresolved together. */
  positions: number | null;
  /** Share of the fund's weight that resolved to a company, as a percentage. */
  coveragePct: number | null;
  /** End of the fund's N-PORT reporting period. */
  asOf: string | null;
  /** The date that filing was filed. */
  filedAt: string | null;
  /** Days between the reporting period and the filing. */
  lagDays: number | null;
  /** The share of your ten largest companies this fund supplies, or `null`. */
  top10Share: number | null;
  /** Share of your portfolio in this fund's positions that resolved to no company. */
  unmatchedWeight: number | null;
  /** Positions in the fund's filing with no company: securities, cash, derivatives. */
  unmatchedPositions: number | null;
}

/** One row per fund in the mix, in the order the portfolio lists them. */
export function fundMixRows(input: {
  tickers: readonly string[];
  weights: Record<string, number>;
  docs: Map<string, FundDocument>;
  top10: Top10Attribution | null;
}): FundMixRow[] {
  const top10Total = input.top10?.total ?? 0;

  return input.tickers.map((ticker) => {
    const document = input.docs.get(ticker);
    const contribution = input.top10?.byFund.get(ticker) ?? 0;
    const weight = input.weights[ticker] ?? 0;

    // The fund's own filing, weighted into your portfolio. `Σ weight × bp / 10⁴` over
    // the positions with no company is what the ledger's `unmapped` weights add up
    // to, computed here per fund so the column can be checked against the total.
    let unmatchedWeight = 0;
    let unmatchedPositions = 0;
    if (document) {
      for (const holding of document.holdings) {
        if (holding.company_id) continue;
        unmatchedPositions += 1;
        unmatchedWeight += weight * (holding.weight_bp / 10_000);
      }
    }

    return {
      ticker,
      name: document?.name ?? null,
      weight,
      positions: document ? document.holdings.length : null,
      coveragePct: document ? document.coverage_pct : null,
      asOf: document?.as_of ?? null,
      filedAt: document?.filed_at ?? null,
      lagDays: document?.lag_days ?? null,
      top10Share: top10Total > 0 ? contribution / top10Total : null,
      unmatchedWeight: document ? unmatchedWeight : null,
      unmatchedPositions: document ? unmatchedPositions : null,
    };
  });
}
