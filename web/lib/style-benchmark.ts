/**
 * The style benchmark: an eligibility gate, a composite builder, and active share.
 *
 * Proof of concept for `equity-style-benchmark-plan.md` §6–§8. Three rules from the
 * plan are load-bearing here and are the reason the code is shaped this way:
 *
 * - **The gate fails closed.** An untagged fund, a fund whose holdings do not belong in
 *   the class's region, or two families in one portfolio all hide the feature. A style
 *   number computed over a portfolio the registry cannot describe would be a guess with
 *   a decimal point.
 * - **The benchmark is a look-through, not a fund.** A class's weight for a company is
 *   the equal-weighted average of its members' weight in that company — the same
 *   company-id roll-up the ledger does, so a company held by two members once is one
 *   row in the benchmark too.
 * - **Active share is a distance, not a score.** `½ Σ |yours − benchmark|` over the union
 *   of companies, which is the standard active-share definition and is symmetric.
 *
 * Nothing here reads the DOM, React, or the network: every function takes documents it
 * is given and returns numbers, so the plan's §10 checks are ordinary unit tests.
 */

import type { FundDocument } from "./types";

import {
  STYLE_CLASS_BY_ID,
  classOf,
  type StyleClass,
  type StyleFamily,
  type StyleRegion,
} from "./style-registry";

/** Funds below this share of the portfolio are ignored by the gate (§6 rule 1). */
export const MIN_FUND_WEIGHT = 0.0001;

/**
 * A member whose filing is older than the newest member's by more than this is dropped
 * from the composite (§7 rule 6). 120 days is the plan's number, and it is generous on
 * purpose: N-PORT is filed quarterly, so a healthy class routinely has members 90 days
 * apart.
 */
export const MAX_MEMBER_LAG_DAYS = 120;

/** Basis points in 100% — the release's integer unit (`types.FULL_ALLOCATION_BP`). */
const FULL_ALLOCATION_BP = 10_000;

/** One fund in the portfolio, as the gate sees it. */
export interface PortfolioFund {
  ticker: string;
  /** Fraction of the portfolio. */
  weight: number;
}

/** The regional composition of a fund's look-through, as fractions of its own NAV. */
export interface RegionMix {
  us: number;
  dm: number;
  em: number;
  /** Weight the release could not place in any of the three. */
  unplaced: number;
}

export type GateResult =
  | {
      eligible: true;
      family: StyleFamily;
      /** Each class the portfolio touches, with its share of the funds. Sums to 1. */
      classes: { classId: string; alloc: number }[];
      /** True when the portfolio is all in one class — the caption can name it outright. */
      single: boolean;
    }
  | {
      eligible: false;
      reason: "empty" | "unclassified" | "mixed_family" | "region_fail";
      offenders: string[];
    };

export interface GateOptions {
  /** §6's optional restriction: refuse to mix US and non-US in one style column. */
  requireSingleRegion?: boolean;
  /** The region mix of a fund's look-through, or `null` when it is not known yet. */
  regionMix: (ticker: string) => RegionMix | null;
}

/**
 * A fund fails the class's region purity when its look-through is not mostly there.
 *
 * Measured **over the weight the release can place**, not over the whole NAV. The plan's
 * rule is about where a fund invests — "a US class must not contain an international
 * fund" — and cash, a derivative, or a company with no country says nothing about that.
 * Dividing by the whole NAV would fail a genuinely developed-markets fund on a 20% cash
 * sleeve and hide the column for a reason that has nothing to do with style; coverage is
 * already its own membership rule (§3 rule 4, 95%). `unplaced` is still carried in the mix
 * so the hint can print it.
 */
function regionPurity(mix: RegionMix, region: StyleRegion): number {
  const placed = mix.us + mix.dm + mix.em;
  if (placed <= 0) return 0;
  const share = region === "US" ? mix.us : region === "INTL" ? mix.dm : mix.em;
  return share / placed;
}

function requiredPurity(styleClass: StyleClass): number {
  return styleClass.purity;
}

/**
 * §6: decide whether this portfolio has a style benchmark, and if so which classes and
 * in what proportion.
 *
 * The order is the plan's and it matters: "unclassified" outranks "mixed family", so a
 * portfolio with a multifactor fund is reported as unclassifiable rather than as a mix,
 * because tagging that fund is the fix and mixing is not.
 */
export function resolveStyleBenchmark(
  funds: PortfolioFund[],
  options: GateOptions,
): GateResult {
  const considered = funds
    .filter((fund) => fund.weight >= MIN_FUND_WEIGHT)
    .map((fund) => ({ ...fund, ticker: fund.ticker.toUpperCase() }));

  if (considered.length === 0) {
    return { eligible: false, reason: "empty", offenders: [] };
  }

  // Rule 3: one untagged fund hides the feature, and the line names it.
  const pairs: { fund: PortfolioFund; styleClass: StyleClass }[] = [];
  const untagged: string[] = [];
  for (const fund of considered) {
    const styleClass = classOf(fund.ticker);
    if (styleClass) pairs.push({ fund, styleClass });
    else untagged.push(fund.ticker);
  }
  if (untagged.length > 0) {
    return { eligible: false, reason: "unclassified", offenders: untagged };
  }

  // Rule 4: the hard region check (§5b). An unknown mix is not a failure — the country
  // map may still be in flight, and the hook re-runs the gate when it lands.
  const offRegion: string[] = [];
  for (const { fund, styleClass } of pairs) {
    const mix = options.regionMix(fund.ticker);
    if (!mix) continue;
    const actual = regionPurity(mix, styleClass.region);
    if (actual + 1e-9 < requiredPurity(styleClass)) {
      offRegion.push(
        `${fund.ticker} (${Math.round(actual * 100)}% ${styleClass.region})`,
      );
    }
  }
  if (offRegion.length > 0) {
    return { eligible: false, reason: "region_fail", offenders: offRegion };
  }

  // Rule 5: one family per column.
  const families = new Set(pairs.map((pair) => pair.styleClass.family));
  if (families.size > 1) {
    return {
      eligible: false,
      reason: "mixed_family",
      offenders: [...new Set(pairs.map((pair) => pair.styleClass.display))],
    };
  }

  if (options.requireSingleRegion) {
    const regions = new Set(pairs.map((pair) => pair.styleClass.region));
    if (regions.size > 1) {
      return {
        eligible: false,
        reason: "mixed_family",
        offenders: [...new Set(pairs.map((pair) => pair.styleClass.display))],
      };
    }
  }

  // Rule 6: eligible. `alloc` is each class's share of the funds considered, so it sums
  // to 1 whatever the portfolio's cash and unresolved weight do.
  const totalWeight = pairs.reduce((sum, pair) => sum + pair.fund.weight, 0);
  const byClass = new Map<string, number>();
  for (const { fund, styleClass } of pairs) {
    byClass.set(
      styleClass.id,
      (byClass.get(styleClass.id) ?? 0) + fund.weight / totalWeight,
    );
  }

  const [family] = [...families];
  if (!family) return { eligible: false, reason: "empty", offenders: [] };

  return {
    eligible: true,
    family,
    classes: [...byClass.entries()]
      .map(([classId, alloc]) => ({ classId, alloc }))
      .sort((a, b) => b.alloc - a.alloc),
    single: byClass.size === 1,
  };
}

/** A class's name, for a caption or an offender line. */
export function classLabel(styleClass: StyleClass): string {
  return styleClass.display;
}

/** One member of a composite, with the provenance the caption prints. */
export interface CompositeMember {
  ticker: string;
  asOf: string;
  coveragePct: number;
}

export interface ClassBenchmark {
  classId: string;
  /** Company id to fraction of the composite. Sums to the members' mean coverage. */
  weights: Record<string, number>;
  members: CompositeMember[];
  /** Members the registry names but the release could not supply, or that went stale. */
  dropped: { ticker: string; why: "missing" | "stale" }[];
  /** The newest filing date among the members used. */
  asOf: string | null;
}

/**
 * §7: build a class's benchmark from its members' published look-through vectors.
 *
 * `documents` are the member funds the caller could load; the registry's list is the
 * authority on membership, so a member missing here is reported rather than silently
 * excluded from the average — an average over three of four members is a different
 * benchmark.
 */
export function compositeFromDocuments(
  classId: string,
  documents: FundDocument[],
  options: { maxLagDays?: number } = {},
): ClassBenchmark {
  const styleClass = STYLE_CLASS_BY_ID.get(classId);
  if (!styleClass) throw new Error(`unknown style class ${classId}`);
  const byTicker = new Map(
    documents.map((document) => [document.ticker.toUpperCase(), document]),
  );

  const dropped: ClassBenchmark["dropped"] = [];
  const present: FundDocument[] = [];
  for (const ticker of styleClass.members) {
    const document = byTicker.get(ticker);
    if (document) present.push(document);
    else dropped.push({ ticker, why: "missing" });
  }
  if (present.length === 0) {
    return { classId, weights: {}, members: [], dropped, asOf: null };
  }

  const newest = present.reduce(
    (latest, document) => (document.as_of > latest ? document.as_of : latest),
    "",
  );
  const maxLagDays = options.maxLagDays ?? MAX_MEMBER_LAG_DAYS;
  const fresh = present.filter((document) => {
    const lag = daysBetween(document.as_of, newest);
    if (lag <= maxLagDays) return true;
    dropped.push({ ticker: document.ticker, why: "stale" });
    return false;
  });
  if (fresh.length === 0) {
    return { classId, weights: {}, members: [], dropped, asOf: null };
  }

  // Equal weight, then the same company-id roll-up the ledger uses: two share classes of
  // one issuer are one company, and a row with no company is not a company.
  const totals = new Map<string, number>();
  for (const document of fresh) {
    const share = 1 / fresh.length;
    for (const holding of document.holdings) {
      if (!holding.company_id || holding.weight_bp === 0) continue;
      const weight = (holding.weight_bp / FULL_ALLOCATION_BP) * share;
      totals.set(holding.company_id, (totals.get(holding.company_id) ?? 0) + weight);
    }
  }

  const weights: Record<string, number> = {};
  for (const [companyId, weight] of totals) weights[companyId] = weight;

  return {
    classId,
    weights,
    members: fresh.map((document) => ({
      ticker: document.ticker,
      asOf: document.as_of,
      coveragePct: document.coverage_pct,
    })),
    dropped,
    asOf: newest,
  };
}

/** §6: a company's style weight is the allocation-weighted sum over the classes. */
export function blendWeights(
  allocations: { classId: string; alloc: number }[],
  composites: Map<string, ClassBenchmark>,
): Record<string, number> {
  const blended: Record<string, number> = {};
  for (const { classId, alloc } of allocations) {
    const composite = composites.get(classId);
    if (!composite) continue;
    for (const [companyId, weight] of Object.entries(composite.weights)) {
      blended[companyId] = (blended[companyId] ?? 0) + alloc * weight;
    }
  }
  return blended;
}

/**
 * Active share: `½ Σ |portfolio − benchmark|` over every company either side holds.
 *
 * Uncovered benchmark weight (cash, derivatives) is not a company, so it is not in the
 * sum — the same rule the VT column follows. A portfolio and a benchmark that agree
 * exactly return 0, which is the "you hold the benchmark" state the table prints instead
 * of a column of zeros.
 */
export function activeShare(
  portfolio: Record<string, number>,
  benchmark: Record<string, number>,
): number {
  const companies = new Set([...Object.keys(portfolio), ...Object.keys(benchmark)]);
  let total = 0;
  for (const companyId of companies) {
    total += Math.abs((portfolio[companyId] ?? 0) - (benchmark[companyId] ?? 0));
  }
  return total / 2;
}

/** Whole days between two ISO dates, or `0` when either is unparseable. */
function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.abs(end - start) / 86_400_000;
}
