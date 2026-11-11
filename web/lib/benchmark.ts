/**
 * The funds a portfolio can be compared against, and the default.
 *
 * `ADR-0015` fixed VT as the *only* benchmark; its 2026-11-11 amendment keeps VT as the
 * default but lets the reader pick one of five (operator, 2026-11-11). The list is a
 * proxy suite rather than a menu: VT is the whole world, VTI the US total market, VOO the
 * S&P 500, IDEV developed ex-US (MSCI World ex USA IMI) and IEMG emerging markets (MSCI
 * Emerging Markets IMI), so a US-heavy book can be compared with the market it is
 * actually in and an international sleeve with the convention its own funds follow.
 *
 * **One at a time.** The choice is a display preference — which comparison the reader is
 * reading — so it lives in the query string (`?bench=voo`), never in the fragment, which
 * is the portfolio's alone (invariant I3). The default writes nothing, so a visitor who
 * never touches the picker keeps the URL they arrived with.
 *
 * **The comparison does not change meaning.** What the column measures is what it always
 * was (`lookthrough-math-and-qa` §1, `static-xray-frontend` §4a): the benchmark weight is
 * the company's **share of the benchmark fund's own NAV** — that fund's weight in the
 * company, not the visitor's, and unrelated to how much of the portfolio is in the fund
 * (usually none). Every surface names the fund it used — column headings, active-share
 * line, table caption and the exported file — because a comparison that does not say
 * what it is against is a number without provenance.
 *
 * The tickers live here once so the whitelist is a product decision rather than a
 * scattering of string literals, and so `parseBenchmark` can refuse anything else: a
 * free-text ticker would let a reader compare against a fund chosen after seeing the
 * answer.
 */

import {
  FULL_ALLOCATION_BP,
  type BenchmarkComparison,
  type BenchmarkRollup,
  type FundDocument,
} from "./types";

/** The five published funds a comparison may use, in the order the picker shows them. */
export const BENCHMARK_CHOICES = ["VT", "VTI", "VOO", "IDEV", "IEMG"] as const;

/** A fund the comparison may use. */
export type BenchmarkTicker = (typeof BENCHMARK_CHOICES)[number];

/** The default, and the one the original ADR pinned: Vanguard Total World Stock. */
export const DEFAULT_BENCHMARK: BenchmarkTicker = "VT";

/** Whether a string names one of the five choices (the comparison is case-insensitive). */
export function isBenchmarkTicker(value: string): value is BenchmarkTicker {
  return (BENCHMARK_CHOICES as readonly string[]).includes(value);
}

/** A query-string value as a benchmark, or `null` when it names none. */
export function parseBenchmark(value: string | null | undefined): BenchmarkTicker | null {
  if (!value) return null;
  const wanted = value.trim().toUpperCase();
  return isBenchmarkTicker(wanted) ? wanted : null;
}

/**
 * The default under its historic name, for the retired builder and the tests that predate
 * the picker. New code reads `DEFAULT_BENCHMARK`; one value, one definition.
 */
export const BENCHMARK_TICKER: BenchmarkTicker = DEFAULT_BENCHMARK;

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

/**
 * Your weight minus the benchmark's, in the unit both are stored in (a fraction).
 *
 * **This is a difference of two shares of different wholes**, and it is the only
 * arithmetic the benchmark column is allowed to carry (operator decision, ADR-0015,
 * 2026-11-02 amendment). `0.0152 - 0.0406 = -0.0254` is "you hold 2.54 percentage
 * points less of this company than VT does" — it is not a holding, not a share of your
 * portfolio, and never a number that feeds a metric, a ranking, or a score. The
 * ledger's own weights are computed from filings and allocations only.
 *
 * `null` in, `null` out: with no benchmark there is nothing to difference, and the
 * column is absent rather than full of zeros (`static-xray-frontend` §4a).
 */
export function benchmarkDelta(
  portfolioWeight: number,
  benchmarkWeight: number | null,
): number | null {
  return benchmarkWeight === null ? null : portfolioWeight - benchmarkWeight;
}
