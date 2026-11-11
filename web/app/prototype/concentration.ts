/**
 * PROTOTYPE — the concentration curve's pure maths. Throwaway; never merged.
 *
 * The production build will use d3-scale / d3-shape / d3-array for the same
 * functions; the prototype keeps them dependency-free so the design can be
 * judged without adding a package to the repo.
 */

export interface WeightedCompany {
  name: string;
  ticker: string | null;
  weight: number;
}

/** Descending by weight, ties by name — the one order the curve and the tooltip use. */
export function sortWeights(weights: readonly WeightedCompany[]): WeightedCompany[] {
  return [...weights]
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
}

/** Sort descending by weight, ties by name, then cumulative sums. C[N] = 1. */
export function cumulativeCurve(weights: readonly WeightedCompany[]): number[] {
  const sorted = sortWeights(weights);
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return [];
  let running = 0;
  const curve = sorted.map((entry) => {
    running += entry.weight / total;
    return running;
  });
  // Clamp the last point: float addition can land a hair either side of 1.
  if (curve.length > 0) curve[curve.length - 1] = 1;
  return curve;
}

/** Smallest k (1-based) where C[k] >= p. */
export function kAt(curve: readonly number[], p: number): number {
  for (let index = 0; index < curve.length; index += 1) {
    if ((curve[index] ?? 0) >= p) return index + 1;
  }
  return curve.length;
}

export function k50(curve: readonly number[]): number {
  return kAt(curve, 0.5);
}

/** C[min(n, N)] — the share of money in the top n companies. */
export function topShare(curve: readonly number[], n: number): number {
  if (curve.length === 0) return 0;
  return curve[Math.min(n, curve.length) - 1] ?? 0;
}

/**
 * A shared x-grid: every integer 1–100, then ~140 log-spaced integers up to maxN.
 * Deduplicated, sorted, always ending at maxN, at most 260 points.
 */
export function logGrid(maxN: number): number[] {
  const top = Math.max(1, Math.floor(maxN));
  const grid = new Set<number>();
  for (let rank = 1; rank <= Math.min(100, top); rank += 1) grid.add(rank);
  if (top > 100) {
    const steps = 140;
    const start = Math.log10(101);
    const end = Math.log10(top);
    for (let index = 0; index <= steps; index += 1) {
      const rank = Math.round(10 ** (start + ((end - start) * index) / steps));
      if (rank >= 101 && rank <= top) grid.add(rank);
    }
  }
  grid.add(top);
  return [...grid].sort((a, b) => a - b);
}

/** C[min(r, N)] for each grid rank; monotone non-decreasing, ends at 1. */
export function resample(
  curve: readonly number[],
  grid: readonly number[],
): Array<[number, number]> {
  if (curve.length === 0) return [];
  return grid.map((rank) => [rank, curve[Math.min(rank, curve.length) - 1] ?? 1]);
}

/**
 * The rank under a pointer, on the log x-axis.
 *
 * `left`/`width` are the plot area in the same units as `px`; the inverse of
 * `x(rank) = left + log10(rank)/log10(maxN) * width`.
 */
export function invertRank(
  px: number,
  left: number,
  width: number,
  maxN: number,
): number {
  if (width <= 0 || maxN <= 1) return 1;
  const ratio = Math.min(1, Math.max(0, (px - left) / width));
  const rank = 10 ** (ratio * Math.log10(maxN));
  return Math.min(maxN, Math.max(1, Math.round(rank)));
}
