/**
 * The Effective holdings block's view model: the numbers the redesigned block prints.
 *
 * The arithmetic itself is `effective-holdings.ts`'s and is not repeated here. This module
 * only turns the ledger's rows, the selected benchmark and the fund count into the fields
 * the block renders — the effective and lenient counts, the no-overlap pair, the top-ten
 * share of money, the benchmark's own count and the verdict — so the component is a
 * rendering of one tested object rather than a place where numbers are computed.
 *
 * Definitions, all of them the plan's and `lookthrough-math-and-qa`'s:
 * - **effective** = 1 / Σ sᵢ² over company shares of the matched total (the old "Core").
 * - **lenient** = exp(−Σ sᵢ ln sᵢ) over the same shares (the old "Broad").
 * - **no-overlap** = the same two counts with every fund × company position separate.
 * - **top-ten share of money** = Σ of the ten largest company weights, as a share of the
 *   whole portfolio (not of the matched total, and not the HHI share).
 * - **benchmark effective** = 1 / Σ ŵᵢ² over the benchmark's company weights normalised to
 *   its own traced total. The benchmark payload is shares of that fund's NAV and sums to
 *   slightly less than 1, so normalising is what makes the comparison like for like.
 * - **ratio** = benchmark effective / effective; the verdict's thresholds are the plan's
 *   (≥ 1.15 more concentrated, ≤ 0.87 more diversified, otherwise about as diversified).
 */

import type { EffectiveHoldings } from "./effective-holdings";
import { formatCount } from "./format";
import type { BenchmarkComparison, LedgerRow } from "./types";

export interface EffectiveHoldingsView {
  owned: number;
  effective: number | null;
  lenient: number | null;
  noOverlapEffective: number | null;
  noOverlapLenient: number | null;
  overlapCostPct: number | null;
  top10WeightPct: number | null;
  top10HhiSharePct: number | null;
  top1: { name: string; ticker: string | null; weightPct: number } | null;
  worstOverlap: { name: string; heldBy: number } | null;
  fundCount: number;
  coveredPct: number | null;
  benchmark: { ticker: string; effective: number } | null;
  ratio: number | null;
  verdict: string | null;
  band: DiversificationBand | null;
  headline: string;
  singleStock: boolean;
  singleFund: boolean;
  noShared: boolean;
}

/**
 * The single-company-risk bands: a design choice informed by the research, not a
 * published standard. The cutoffs and their anchors are cited in the block's disclosure:
 * 16 equal-weighted securities (Evans & Archer), 30–40 (Statman), and 164 (Domian,
 * Louton & Racine); the 60 step lands near the 100-stock shortfall odds the same
 * literature reports. The band says how evenly the money is spread across companies —
 * never how good the portfolio is, and never anything about correlation.
 */
export const DIVERSIFICATION_BANDS = [
  {
    key: "very-concentrated",
    label: "Very concentrated",
    colour: "Red",
    token: 1,
    min: 0,
    max: 10,
  },
  {
    key: "concentrated",
    label: "Concentrated",
    colour: "Orange",
    token: 2,
    min: 10,
    max: 30,
  },
  { key: "moderate", label: "Moderate", colour: "Yellow", token: 3, min: 30, max: 60 },
  {
    key: "diversified",
    label: "Diversified",
    colour: "Light green",
    token: 4,
    min: 60,
    max: 150,
  },
  {
    key: "broadly-diversified",
    label: "Broadly diversified",
    colour: "Green",
    token: 5,
    min: 150,
    max: Number.POSITIVE_INFINITY,
  },
] as const;

export type DiversificationBand = (typeof DIVERSIFICATION_BANDS)[number];

/**
 * The band an effective count falls in; the top band is open-ended.
 *
 * One helper for the block and the curve: the headline's band and the line's colour are
 * the same call on the same unrounded number, so they cannot disagree.
 */
export function bandFor(effective: number): DiversificationBand {
  const found = DIVERSIFICATION_BANDS.find(
    (band) => effective >= band.min && effective < band.max,
  );
  return (
    found ??
    DIVERSIFICATION_BANDS[DIVERSIFICATION_BANDS.length - 1] ??
    DIVERSIFICATION_BANDS[0]
  );
}

/** One decimal below 1.5 (two companies split almost evenly), an integer otherwise. */
export function effectiveWords(value: number): string {
  return value < 1.5 ? value.toFixed(1) : formatCount(Math.round(value));
}

/**
 * The benchmark's own effective count, normalised to its traced total.
 *
 * `weights` are shares of the benchmark fund's own NAV; they sum to its coverage, not to
 * 1, so the shares are renormalised before the HHI. A benchmark with no traced weight has
 * no count.
 */
export function benchmarkEffective(
  weights: Record<string, number> | null | undefined,
): number | null {
  const values = Object.values(weights ?? {}).filter((weight) => weight > 0);
  const total = values.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return null;
  const hhi = values.reduce((sum, weight) => sum + (weight / total) ** 2, 0);
  return hhi > 0 ? 1 / hhi : null;
}

/** The plan's three-way verdict, or `null` when there is no benchmark to compare with. */
export function verdictLine(ratio: number | null, ticker: string): string | null {
  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) return null;
  if (ratio >= 1.15)
    return `About ${ratio.toFixed(1)}× more concentrated than ${ticker}.`;
  if (ratio <= 0.87)
    return `About ${(1 / ratio).toFixed(1)}× more diversified than ${ticker}.`;
  return `About as diversified as ${ticker}.`;
}

/** The ten largest companies' share of the whole portfolio, in percent. */
export function top10WeightPct(rows: readonly LedgerRow[]): number | null {
  if (rows.length === 0) return null;
  const largest = [...rows]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10)
    .reduce((sum, row) => sum + row.weight, 0);
  return largest * 100;
}

/** The company held by the most funds; ties go to the larger portfolio weight. */
export function worstOverlap(
  rows: readonly LedgerRow[],
): { name: string; heldBy: number } | null {
  if (rows.length === 0) return null;
  const worst = [...rows].sort(
    (a, b) => b.holder_count - a.holder_count || b.weight - a.weight,
  )[0];
  return worst ? { name: worst.name, heldBy: worst.holder_count } : null;
}

export function buildEffectiveHoldingsView(input: {
  effective: EffectiveHoldings;
  rows: readonly LedgerRow[];
  benchmark: BenchmarkComparison | null;
  fundCount: number;
  directCount: number;
}): EffectiveHoldingsView {
  const { effective, rows, benchmark, fundCount, directCount } = input;
  const core = effective.core;
  const noOverlap = effective.coreDisjoint;
  const benchmarkCount = benchmark ? benchmarkEffective(benchmark.weights) : null;
  const ratio =
    benchmarkCount !== null && core !== null && core > 0 ? benchmarkCount / core : null;
  const worst = worstOverlap(rows);
  const top1 =
    rows.length > 0 ? ([...rows].sort((a, b) => b.weight - a.weight)[0] ?? null) : null;
  const singleStock = rows.length === 1 && fundCount === 0 && directCount === 1;

  return {
    owned: effective.companies,
    effective: core,
    lenient: effective.broad,
    noOverlapEffective: noOverlap,
    noOverlapLenient: effective.broadDisjoint,
    overlapCostPct:
      core !== null && noOverlap !== null && noOverlap > 0
        ? Math.round((1 - core / noOverlap) * 100)
        : null,
    top10WeightPct: top10WeightPct(rows),
    top10HhiSharePct:
      effective.topTenConcentrationShare === null
        ? null
        : effective.topTenConcentrationShare * 100,
    top1:
      top1 === null
        ? null
        : { name: top1.name, ticker: top1.ticker, weightPct: top1.weight * 100 },
    worstOverlap: worst,
    fundCount,
    coveredPct: effective.matchedWeight * 100,
    benchmark:
      benchmark && benchmarkCount !== null
        ? { ticker: benchmark.ticker, effective: benchmarkCount }
        : null,
    ratio,
    verdict: benchmark ? verdictLine(ratio, benchmark.ticker) : null,
    band: core === null ? null : bandFor(core),
    headline: singleStock
      ? "Your portfolio is one company."
      : core === null
        ? ""
        : `You own ${formatCount(effective.companies)} companies, but your portfolio behaves like ${effectiveWords(core)} equally weighted ones.`,
    singleStock,
    singleFund: fundCount === 1,
    noShared: fundCount > 1 && (worst?.heldBy ?? 0) < 2,
  };
}
