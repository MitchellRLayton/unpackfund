/**
 * Look-through aggregation. This is the product's arithmetic, so it follows
 * `lookthrough-math-and-qa` §1–§5 rather than convenience:
 *
 *   total(i) = w_direct(i) + Σ_k W_k · w_{i,k}
 *
 * with `W_k` the portfolio's weight in fund k, `w_{i,k}` company i's weight inside
 * fund k, and `w_direct(i)` the visitor's own position in company i when they hold
 * it directly (ADR-0014; the skill's §1 predates direct holdings).
 *
 * Rollup is by `company_id`, never by ticker — two share classes of one issuer are
 * one company line (math §3), and a ticker is not identity. That is also why a
 * direct Amazon position and VT's filed Amazon row add up to one line instead of
 * two: both carry `c_0001018724`.
 *
 * Deliberate exclusions, each one a rule rather than a shortcut:
 * - holdings with no `company_id` stay unmapped: counted and disclosed, never
 *   redistributed across resolved companies (that is how a low-coverage fund would
 *   look average);
 * - cash has no company identity and is excluded from coverage, but it is part of
 *   the visitor's money, so it dilutes concentration rather than being ignored;
 * - a negative (short) weight is a real exposure but is excluded from
 *   concentration math, where `Σ wᵢ²` would otherwise reward the short;
 * - a holding of zero weight cannot affect a sum and only inflates counts.
 */

import { effectiveHoldingsForLedger } from "./effective-holdings";
import { coverageBand } from "./format";
import {
  FULL_ALLOCATION_BP,
  type BenchmarkComparison,
  type BenchmarkFacts,
  type DirectHolding,
  type FundDocument,
  type Ledger,
  type LedgerMetrics,
  type LedgerRow,
  type LedgerSource,
} from "./types";

export interface AggregateInput {
  funds: FundDocument[];
  /** Fund ticker → portfolio weight, as a **fraction** of the whole portfolio. */
  weights: Record<string, number>;
  /** Positions the visitor holds directly, each already weighted as a fraction. */
  direct?: DirectHolding[];
  /** Cash as a fraction of the whole portfolio; never a coverage candidate. */
  cash?: number;
  /**
   * The fixed benchmark's per-company weights ([ADR-0015](../../../docs/04-decisions/ADR-0015-vt-benchmark.md)).
   * Absent means the release publishes no benchmark, and every row reports
   * `benchmark_weight: null` rather than a zero that would claim the benchmark
   * holds nothing.
   */
  benchmark?: BenchmarkComparison | null;
  /**
   * `company_id → ISO-3166-1 alpha-2` from the release's `companies/countries.json`.
   *
   * Absent (or `null`) means the release publishes no country object, and every row
   * then reports `country: null` — the question is unanswered, which is not the same as
   * "no country" and must never render as a default. This is a **lookup**, not a
   * computation: the browser does not aggregate, vote, or infer a code, because the rule
   * that decided one lives in the pipeline (`data-contract-and-release` §5).
   */
  countries?: Record<string, string> | null;
}

/** Companies rarely exceed this many in one portfolio; the guard is for sanity. */
const MAX_TOP = 10;

export function buildLedger({
  funds,
  weights,
  direct = [],
  cash = 0,
  benchmark = null,
  countries = null,
}: AggregateInput): Ledger {
  interface Accumulator {
    name: string;
    nameWeight: number;
    ticker: string | null;
    weight: number;
    /** Distinct funds holding it: two share classes in one fund are one holder. */
    fundTickers: Set<string>;
    heldDirectly: boolean;
    sources: LedgerSource[];
  }

  const companies = new Map<string, Accumulator>();
  // The quantities the "not traced" disclosure needs, counted once here so the UI
  // cannot disagree with the weights it is describing (math §7a).
  let unmappedPositions = 0;
  let unmappedWithWeight = 0;
  let securitiesWithWeight = 0;
  let securitiesWeight = 0;
  let cashAndDerivativesWithWeight = 0;
  let cashAndDerivativesWeight = 0;
  /** `Σ W_k` over funds — the fund part of the invested denominator. */
  let fundWeightFraction = 0;
  /** `Σ W_k · (1 − c_k)`: the weight inside funds we could not name. */
  let fundUncoveredWeight = 0;
  let suppressedWeight = 0;
  let directWeight = 0;

  const contributingFunds: Ledger["funds"] = [];
  let oldestAsOf: string | null = null;
  let maxLagDays: number | null = null;

  for (const fund of funds) {
    const fundWeight = weights[fund.ticker] ?? 0;
    if (fundWeight <= 0) continue;

    fundWeightFraction += fundWeight;
    // Coverage is a statement about money that resolved, so the missing share is
    // accumulated as weight rather than averaged as a percentage: a fund at 40%
    // coverage must not be able to look better by being small.
    fundUncoveredWeight += fundWeight * (1 - fund.coverage_pct / 100);
    if (coverageBand(fund.coverage_pct) === "none") suppressedWeight += fundWeight;

    const contributing: Ledger["funds"][number] = {
      ticker: fund.ticker,
      name: fund.name,
      as_of: fund.as_of,
      filed_at: fund.filed_at,
      lag_days: fund.lag_days,
      coverage_pct: fund.coverage_pct,
      source_url: fund.source_url,
    };
    // The two coverage shares travel with the fund only when the release measures
    // them, so a document from an earlier release produces exactly the object it
    // produced before this field existed — no key, no `undefined` in the JSON.
    if (fund.identified_pct !== undefined) {
      contributing.identified_pct = fund.identified_pct;
    }
    if (fund.coverage_by_cat !== undefined) {
      contributing.coverage_by_cat = fund.coverage_by_cat;
    }
    if (fund.identified_by_cat !== undefined) {
      contributing.identified_by_cat = fund.identified_by_cat;
    }
    contributingFunds.push(contributing);
    if (oldestAsOf === null || fund.as_of < oldestAsOf) oldestAsOf = fund.as_of;
    maxLagDays =
      maxLagDays === null ? fund.lag_days : Math.max(maxLagDays, fund.lag_days);

    for (const holding of fund.holdings) {
      if (!holding.company_id) {
        unmappedPositions += 1;
        // A position that rounds to zero basis points cannot move a weight, so it
        // is counted but never described as money: that distinction is the whole
        // reason "3,126 holdings unmapped" was misleading.
        if (holding.weight_bp !== 0) {
          unmappedWithWeight += 1;
          const contribution = fundWeight * (holding.weight_bp / 10_000);
          // Cash and derivatives have no company by definition (math §3); they
          // are part of the gap in coverage but never a mapping failure.
          if (holding.asset_cat === "cash" || holding.asset_cat === "derivative") {
            cashAndDerivativesWithWeight += 1;
            cashAndDerivativesWeight += contribution;
          } else {
            securitiesWithWeight += 1;
            securitiesWeight += contribution;
          }
        }
        continue;
      }
      if (holding.weight_bp === 0) continue;

      const contribution = fundWeight * (holding.weight_bp / 10_000);
      const existing = companies.get(holding.company_id);
      if (existing) {
        existing.weight += contribution;
        existing.fundTickers.add(fund.ticker);
        existing.sources.push({
          kind: "fund",
          ref: fund.ticker,
          weight: contribution,
        });
        // Keep the name of the source that contributes most, so the label does not
        // depend on iteration order.
        if (holding.weight_bp > existing.nameWeight) {
          existing.nameWeight = holding.weight_bp;
          existing.name = holding.name;
          existing.ticker = holding.ticker ?? existing.ticker;
        } else if (existing.ticker === null && holding.ticker) {
          existing.ticker = holding.ticker;
        }
      } else {
        companies.set(holding.company_id, {
          name: holding.name,
          nameWeight: holding.weight_bp,
          ticker: holding.ticker,
          weight: contribution,
          fundTickers: new Set([fund.ticker]),
          heldDirectly: false,
          sources: [{ kind: "fund", ref: fund.ticker, weight: contribution }],
        });
      }
    }
  }

  // The visitor's own positions, merged into the same accumulator as the funds.
  // `holder_count` is deliberately not incremented: it counts funds, so a company
  // that is only a direct holding reads "0 funds", which is the truth.
  for (const holding of direct) {
    if (holding.weight <= 0) continue;
    directWeight += holding.weight;
    const existing = companies.get(holding.company_id);
    if (existing) {
      existing.weight += holding.weight;
      existing.heldDirectly = true;
      existing.sources.push({
        kind: "security",
        ref: holding.ticker,
        weight: holding.weight,
      });
      // The registered SEC title wins for a company the visitor owns outright: it
      // is the name the confirmation step showed them.
      existing.name = holding.name;
      existing.ticker = holding.ticker;
    } else {
      companies.set(holding.company_id, {
        name: holding.name,
        nameWeight: 0,
        ticker: holding.ticker,
        weight: holding.weight,
        fundTickers: new Set<string>(),
        heldDirectly: true,
        sources: [{ kind: "security", ref: holding.ticker, weight: holding.weight }],
      });
    }
  }

  const rows: LedgerRow[] = [...companies.entries()]
    .map(([companyId, company]) => ({
      company_id: companyId,
      name: company.name,
      ticker: company.ticker,
      weight: company.weight,
      // A share of the benchmark's NAV, read straight from the benchmark's own
      // filing. Zero is a fact here ("its traced holdings do not include this
      // company"), never a stand-in for "not loaded" — that is `null`, and it only
      // happens when the release publishes no benchmark at all.
      benchmark_weight: benchmark === null ? null : (benchmark.weights[companyId] ?? 0),
      // A lookup into the release's map, nothing more: a company the pipeline could not
      // decide stays `null` and renders as no tag, never as a default domicile.
      country: countries?.[companyId] ?? null,
      holder_count: company.fundTickers.size,
      held_directly: company.heldDirectly,
      sources: company.sources
        .slice()
        .sort(
          (a, b) =>
            b.weight - a.weight ||
            (a.kind === b.kind ? 0 : a.kind < b.kind ? -1 : 1) ||
            (a.ref < b.ref ? -1 : 1),
        ),
    }))
    .sort((a, b) => b.weight - a.weight || (a.company_id < b.company_id ? -1 : 1));

  const investedWeight = fundWeightFraction + directWeight;
  const metrics = computeMetrics(rows, {
    investedWeight,
    // Coverage counts named money over invested money, with cash outside both
    // terms — so adding cash can never raise it (math §5).
    coveredWeightPct:
      investedWeight > 0 ? 100 * (1 - fundUncoveredWeight / investedWeight) : 0,
    suppressedWeight,
    cashWeight: Math.max(0, cash),
    unallocatedWeight: Math.max(0, 1 - cash - investedWeight),
  });

  // The weights map is ~2,400 entries on the live release and is not part of the
  // answer: the rows carry the per-company value, and the ledger keeps only the
  // provenance the caption has to state (`static-xray-frontend` §6, conventions I4).
  const benchmarkFacts: BenchmarkFacts | null =
    benchmark === null
      ? null
      : {
          ticker: benchmark.ticker,
          name: benchmark.name,
          as_of: benchmark.as_of,
          filed_at: benchmark.filed_at,
          lag_days: benchmark.lag_days,
          coverage_pct: benchmark.coverage_pct,
          source_url: benchmark.source_url,
        };

  const effective = effectiveHoldingsForLedger({
    rows,
    unmapped: {
      positions: unmappedPositions,
      positions_with_weight: unmappedWithWeight,
      securities_with_weight: securitiesWithWeight,
      securities_weight: securitiesWeight,
      cash_and_derivatives_with_weight: cashAndDerivativesWithWeight,
      cash_and_derivatives_weight: cashAndDerivativesWeight,
    },
  });

  return {
    rows,
    metrics,
    effective,
    benchmark: benchmarkFacts,
    funds: contributingFunds,
    oldest_as_of: oldestAsOf,
    max_lag_days: maxLagDays,
    unmapped: {
      positions: unmappedPositions,
      positions_with_weight: unmappedWithWeight,
      securities_with_weight: securitiesWithWeight,
      securities_weight: securitiesWeight,
      cash_and_derivatives_with_weight: cashAndDerivativesWithWeight,
      cash_and_derivatives_weight: cashAndDerivativesWeight,
    },
  };
}

function computeMetrics(
  rows: LedgerRow[],
  context: {
    investedWeight: number;
    coveredWeightPct: number;
    suppressedWeight: number;
    cashWeight: number;
    unallocatedWeight: number;
  },
): LedgerMetrics {
  const positive = rows.filter((row) => row.weight > 0);

  let hhi: number | null = null;
  let effectiveN: number | null = null;
  let top10: number | null = null;
  let resolvedWeight = 0;

  for (const row of rows) resolvedWeight += row.weight;

  if (positive.length > 0) {
    // A sum of squares near zero is a rounding artefact, not a real HHI; the
    // contract's gate 4 says report null rather than Infinity (math §7).
    const sumSquares = positive.reduce((sum, row) => sum + row.weight * row.weight, 0);
    if (sumSquares > 1e-12) {
      hhi = sumSquares;
      effectiveN = 1 / sumSquares;
    }
    top10 = positive
      .slice()
      .sort((a, b) => b.weight - a.weight || (a.company_id < b.company_id ? -1 : 1))
      .slice(0, MAX_TOP)
      .reduce((sum, row) => sum + row.weight, 0);
  }

  return {
    hhi,
    effective_n: effectiveN,
    top10,
    covered_weight_pct: context.coveredWeightPct,
    resolved_weight: resolvedWeight,
    suppressed_weight: context.suppressedWeight,
    invested_weight: context.investedWeight,
    cash_weight: context.cashWeight,
    unallocated_weight: context.unallocatedWeight,
  };
}
