/**
 * The benchmark every portfolio is compared against.
 *
 * `ADR-0015` fixes it: VT — the Vanguard Total World Stock ETF share class, filed
 * as "VANGUARD TOTAL WORLD STOCK INDEX FUND" — is the default and the only
 * benchmark. There is no picker, no fragment field, and no release descriptor
 * entry that could point the comparison somewhere else, because a comparison
 * against a benchmark the reader chose is a comparison that can be tuned to
 * flatter a portfolio. The ticker lives here once so "not configurable" stays a
 * product decision rather than a scattering of string literals.
 *
 * What the column means, and what it must never be confused with
 * (`lookthrough-math-and-qa` §1, `static-xray-frontend` §4a): the benchmark
 * weight is the company's **share of the benchmark fund's own NAV** — the fund's
 * weight in that company, not the visitor's. It is unrelated to how much of the
 * portfolio the visitor holds in the benchmark (usually zero).
 */

import {
  FULL_ALLOCATION_BP,
  type BenchmarkComparison,
  type BenchmarkRollup,
  type FundDocument,
} from "./types";

/** The one benchmark. Changing this is an ADR, not an edit. */
export const BENCHMARK_TICKER = "VT";

/**
 * Turn a published fund document into the comparison payload.
 *
 * Three rules, all of them the same rules the portfolio's own ledger uses:
 * - roll up by `company_id`, never by ticker or by filed row, so two share
 *   classes of one issuer are one company (`lookthrough-math-and-qa` §3);
 * - a row with no `company_id` is cash, a derivative, or a company the release
 *   could not identify — it cannot be compared, and it stays in the benchmark's
 *   uncovered weight rather than being spread over the companies that did resolve;
 * - a zero-basis-point row moves nothing, so it is dropped rather than stored as
 *   a 0 that reads like a real position.
 *
 * The result is fractions of the benchmark's NAV, converted once here at the
 * boundary from the contract's integer basis points (math §2).
 */
export function benchmarkFor(document: FundDocument): BenchmarkComparison {
  const basisPoints: Record<string, number> = {};
  for (const holding of document.holdings) {
    if (!holding.company_id || holding.weight_bp === 0) continue;
    basisPoints[holding.company_id] =
      (basisPoints[holding.company_id] ?? 0) + holding.weight_bp;
  }

  const weights: Record<string, number> = {};
  for (const [companyId, weightBp] of Object.entries(basisPoints)) {
    weights[companyId] = weightBp / FULL_ALLOCATION_BP;
  }

  return {
    ticker: document.ticker,
    name: document.name,
    as_of: document.as_of,
    filed_at: document.filed_at,
    lag_days: document.lag_days,
    coverage_pct: document.coverage_pct,
    source_url: document.source_url,
    weights,
  };
}

/**
 * The same payload, from the pre-rolled object instead of the fund document.
 *
 * The two producers must agree — a release validates its compact object against the
 * fund document it was rolled from, and `benchmark.test.ts` pins the two functions
 * here to the same answer — so this is an optimisation, not a second definition.
 * The one conversion from integer basis points to fractions happens here and
 * nowhere else, exactly as `benchmarkFor` does it (math §2).
 */
export function benchmarkFromRollup(rollup: BenchmarkRollup): BenchmarkComparison {
  const weights: Record<string, number> = {};
  for (const [companyId, weightBp] of Object.entries(rollup.weights)) {
    weights[companyId] = weightBp / FULL_ALLOCATION_BP;
  }

  return {
    ticker: rollup.ticker,
    name: rollup.name,
    as_of: rollup.as_of,
    filed_at: rollup.filed_at,
    lag_days: rollup.lag_days,
    coverage_pct: rollup.coverage_pct,
    source_url: rollup.source_url,
    weights,
  };
}
