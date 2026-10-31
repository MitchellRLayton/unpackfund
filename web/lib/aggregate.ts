/**
 * Look-through aggregation. This is the product's arithmetic, so it follows
 * `lookthrough-math-and-qa` §1–§4 rather than convenience:
 *
 *   total(i) = Σ_k W_k · w_{i,k}
 *
 * with `W_k` the portfolio's weight in fund k and `w_{i,k}` company i's weight
 * inside fund k. Rollup is by `company_id`, never by ticker — two share classes
 * of one issuer are one company line (math §3), and a ticker is not identity.
 *
 * Deliberate exclusions, each one a rule rather than a shortcut:
 * - holdings with no `company_id` stay unmapped: counted and disclosed, never
 *   redistributed across resolved companies (that is how a low-coverage fund
 *   would look average);
 * - cash and derivatives have no company identity and are excluded from company
 *   metrics but remain part of NAV, which is why the weights need not sum to 1;
 * - a negative (short) weight is a real exposure but is excluded from
 *   concentration math, where `Σ wᵢ²` would otherwise reward the short;
 * - a holding of zero weight cannot affect a sum and only inflates counts.
 */

import { coverageBand } from "./format";
import {
  FULL_ALLOCATION_BP,
  type FundDocument,
  type Ledger,
  type LedgerMetrics,
  type LedgerRow,
} from "./types";

export interface AggregateInput {
  funds: FundDocument[];
  /** Ticker → portfolio weight in basis points. */
  weightsBp: Record<string, number>;
}

/** Companies rarely exceed this many in one portfolio; the guard is for sanity. */
const MAX_TOP = 10;

export function buildLedger({ funds, weightsBp }: AggregateInput): Ledger {
  interface Accumulator {
    name: string;
    nameWeight: number;
    ticker: string | null;
    weight: number;
    sources: Map<string, number>;
  }

  const companies = new Map<string, Accumulator>();
  // The four quantities the "not traced" disclosure needs, counted once here so
  // the UI cannot disagree with the weights it is describing (math §7a).
  let unmappedPositions = 0;
  let unmappedWithWeight = 0;
  let securitiesWithWeight = 0;
  let securitiesWeight = 0;
  let cashAndDerivativesWithWeight = 0;
  let cashAndDerivativesWeight = 0;
  let portfolioWeightFraction = 0;
  let coveredWeightPct = 0;
  let suppressedWeight = 0;

  const contributingFunds: Ledger["funds"] = [];
  let oldestAsOf: string | null = null;
  let maxLagDays: number | null = null;

  for (const fund of funds) {
    const weightBp = weightsBp[fund.ticker] ?? 0;
    if (weightBp <= 0) continue;

    const fundWeight = weightBp / FULL_ALLOCATION_BP;
    portfolioWeightFraction += fundWeight;
    coveredWeightPct += fundWeight * fund.coverage_pct;
    if (coverageBand(fund.coverage_pct) === "none") suppressedWeight += fundWeight;

    contributingFunds.push({
      ticker: fund.ticker,
      name: fund.name,
      as_of: fund.as_of,
      filed_at: fund.filed_at,
      lag_days: fund.lag_days,
      coverage_pct: fund.coverage_pct,
      source_url: fund.source_url,
    });
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
          const contribution = fundWeight * (holding.weight_bp / FULL_ALLOCATION_BP);
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

      const contribution = fundWeight * (holding.weight_bp / FULL_ALLOCATION_BP);
      const existing = companies.get(holding.company_id);
      if (existing) {
        existing.weight += contribution;
        existing.sources.set(
          fund.ticker,
          (existing.sources.get(fund.ticker) ?? 0) + contribution,
        );
        // Keep the name of the fund that contributes most, so the label does not
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
          sources: new Map([[fund.ticker, contribution]]),
        });
      }
    }
  }

  const rows: LedgerRow[] = [...companies.entries()]
    .map(([companyId, company]) => ({
      company_id: companyId,
      name: company.name,
      ticker: company.ticker,
      weight: company.weight,
      fund_count: company.sources.size,
      sources: [...company.sources.entries()]
        .map(([ticker, weight]) => ({ ticker, weight }))
        .sort((a, b) => b.weight - a.weight || (a.ticker < b.ticker ? -1 : 1)),
    }))
    .sort((a, b) => b.weight - a.weight || (a.company_id < b.company_id ? -1 : 1));

  const metrics = computeMetrics(rows, {
    portfolioWeightFraction,
    coveredWeightPct,
    suppressedWeight,
  });

  return {
    rows,
    metrics,
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
    portfolioWeightFraction: number;
    coveredWeightPct: number;
    suppressedWeight: number;
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

  const denominator =
    context.portfolioWeightFraction > 0 ? context.portfolioWeightFraction : 1;

  return {
    hhi,
    effective_n: effectiveN,
    top10,
    covered_weight_pct: context.coveredWeightPct / denominator,
    resolved_weight: resolvedWeight,
    suppressed_weight: context.suppressedWeight,
  };
}
