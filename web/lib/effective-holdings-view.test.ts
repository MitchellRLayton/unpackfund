import { describe, expect, it } from "vitest";

import type { EffectiveHoldings } from "./effective-holdings";
import {
  benchmarkEffective,
  buildEffectiveHoldingsView,
  effectiveWords,
  top10WeightPct,
  verdictLine,
  worstOverlap,
} from "./effective-holdings-view";
import type { BenchmarkComparison, LedgerRow } from "./types";

/**
 * The block's numbers, hand-checked.
 *
 * The arithmetic lives in `effective-holdings.ts` and is tested there; this file pins the
 * view's own rules — the benchmark normalisation, the verdict thresholds, the top-ten
 * share of money, the overlap tie-break and the edge-case flags — because those are the
 * numbers a reader sees and the plan defines them in words.
 */

function row(
  name: string,
  weight: number,
  holderCount = 1,
  ticker: string | null = null,
): LedgerRow {
  return {
    company_id: `c_${name}`,
    name,
    ticker,
    country: "US",
    weight,
    benchmark_weight: null,
    holder_count: holderCount,
    held_directly: false,
    sources: [{ kind: "fund", ref: "AAA", weight }],
  };
}

function effectiveOf(overrides: Partial<EffectiveHoldings> = {}): EffectiveHoldings {
  return {
    core: 2,
    broad: 2,
    coreDisjoint: 2,
    broadDisjoint: 2,
    topTenConcentrationShare: 1,
    topTenBreadthShare: 1,
    coreRange: null,
    broadRange: null,
    companies: 2,
    hhi: 0.5,
    entropy: Math.log(2),
    matchedWeight: 1,
    unmatchedWeight: 0,
    unmatchedPositions: 0,
    excludedNonCompanyWeight: 0,
    negativeWeight: 0,
    negativePositions: 0,
    coveragePct: 100,
    band: "full",
    ...overrides,
  };
}

function benchmarkOf(weights: Record<string, number>): BenchmarkComparison {
  return {
    ticker: "VT",
    name: "Vanguard Total World Stock ETF",
    as_of: "2026-06-30",
    filed_at: "2026-08-28",
    lag_days: 59,
    coverage_pct: 98,
    source_url: "https://www.sec.gov/x",
    weights,
  };
}

describe("the benchmark's own effective count", () => {
  it("is 1/HHI over the benchmark's weights, normalised to its traced total", () => {
    // Two equal companies: 2, whether the payload sums to 1 or to 0.8.
    expect(benchmarkEffective({ a: 0.5, b: 0.5 })).toBeCloseTo(2, 12);
    expect(benchmarkEffective({ a: 0.4, b: 0.4 })).toBeCloseTo(2, 12);
    // 90/10: 1 / (0.81 + 0.01) = 1.2195…
    expect(benchmarkEffective({ a: 0.9, b: 0.1 })).toBeCloseTo(1.219512, 6);
  });

  it("has no count without traced weight", () => {
    expect(benchmarkEffective({})).toBeNull();
    expect(benchmarkEffective({ a: 0 })).toBeNull();
  });
});

describe("the verdict line", () => {
  it("uses the plan's thresholds, inclusive at both ends", () => {
    expect(verdictLine(1.15, "VT")).toBe("About 1.1× more concentrated than VT.");
    expect(verdictLine(1.149, "VT")).toBe("About as diversified as VT.");
    expect(verdictLine(0.87, "VT")).toBe("About 1.1× more diversified than VT.");
    expect(verdictLine(0.871, "VT")).toBe("About as diversified as VT.");
  });

  it("is absent without a benchmark", () => {
    expect(verdictLine(null, "VT")).toBeNull();
  });
});

describe("the top-ten share of money", () => {
  it("sums the ten largest company weights, as a share of the whole portfolio", () => {
    const rows = Array.from({ length: 12 }, (_, index) => row(`C${index}`, 0.1));
    // Ten of twelve at 10% each: 100% of the money, not 10/12 of it.
    expect(top10WeightPct(rows)).toBeCloseTo(100, 9);
  });

  it("is the whole portfolio when there are fewer than ten companies", () => {
    expect(top10WeightPct([row("A", 0.6), row("B", 0.4)])).toBeCloseTo(100, 9);
  });
});

describe("the worst overlap", () => {
  it("is the company held by the most funds, ties to the larger weight", () => {
    const rows = [
      row("A", 0.1, 3),
      row("B", 0.2, 3),
      row("C", 0.3, 2),
    ];
    expect(worstOverlap(rows)).toEqual({ name: "B", heldBy: 3 });
  });
});

describe("the view", () => {
  it("carries the plan's fields for a two-company portfolio", () => {
    const view = buildEffectiveHoldingsView({
      effective: effectiveOf(),
      rows: [row("A", 0.5), row("B", 0.5)],
      benchmark: benchmarkOf({ a: 0.5, b: 0.5 }),
      fundCount: 1,
      directCount: 0,
    });
    expect(view.owned).toBe(2);
    expect(view.effective).toBe(2);
    expect(view.lenient).toBe(2);
    expect(view.top10WeightPct).toBeCloseTo(100, 9);
    expect(view.top1).toEqual({ name: "A", ticker: null, weightPct: 50 });
    expect(view.benchmark).toEqual({ ticker: "VT", effective: 2 });
    expect(view.ratio).toBeCloseTo(1, 12);
    expect(view.verdict).toBe("About as diversified as VT.");
    expect(view.headline).toBe(
      "You own 2 companies, but your portfolio behaves like 2 equally weighted ones.",
    );
    expect(view.singleFund).toBe(true);
    expect(view.noShared).toBe(false);
  });

  it("computes the overlap cost from the two effective counts", () => {
    const view = buildEffectiveHoldingsView({
      effective: effectiveOf({ core: 2, coreDisjoint: 4 }),
      rows: [row("A", 0.5, 2), row("B", 0.5, 2)],
      benchmark: null,
      fundCount: 2,
      directCount: 0,
    });
    expect(view.overlapCostPct).toBe(50);
    expect(view.verdict).toBeNull();
    expect(view.benchmark).toBeNull();
  });

  it("flags a single stock and a portfolio whose funds share nothing", () => {
    const single = buildEffectiveHoldingsView({
      effective: effectiveOf({ core: 1, broad: 1, companies: 1 }),
      rows: [row("AAPL", 1)],
      benchmark: null,
      fundCount: 0,
      directCount: 1,
    });
    expect(single.singleStock).toBe(true);
    expect(single.headline).toBe("Your portfolio is one company.");

    const disjoint = buildEffectiveHoldingsView({
      effective: effectiveOf(),
      rows: [row("A", 0.5), row("B", 0.5)],
      benchmark: null,
      fundCount: 2,
      directCount: 0,
    });
    expect(disjoint.noShared).toBe(true);
  });

  it("prints one decimal below 1.5 and an integer above it", () => {
    expect(effectiveWords(1.4)).toBe("1.4");
    expect(effectiveWords(1.5)).toBe("2");
    expect(effectiveWords(45.309)).toBe("45");
  });
});
