import { describe, expect, it } from "vitest";

import {
  BENCHMARK_TICKER,
  benchmarkDelta,
  benchmarkFor,
  benchmarkFromRollup,
} from "./benchmark";
import type { BenchmarkRollup, FundDocument, Holding } from "./types";

/**
 * The benchmark payload is a displayed number's only input, so its rules are
 * pinned here rather than inferred from the table: `lookthrough-math-and-qa` §8
 * asks for arithmetic a reader can check on paper, not a snapshot.
 */

const holding = (
  company_id: string | null,
  weight_bp: number,
  asset_cat: Holding["asset_cat"] = "equity",
): Holding => ({
  company_id,
  name: `Company ${company_id ?? "unmapped"}`,
  ticker: null,
  asset_cat,
  weight_bp,
});

function document(
  holdings: Holding[],
  overrides: Partial<FundDocument> = {},
): FundDocument {
  return {
    schema_version: 1,
    ticker: BENCHMARK_TICKER,
    fund_id: "S000022482",
    name: "VANGUARD TOTAL WORLD STOCK INDEX FUND",
    issuer: "VANGUARD INTERNATIONAL EQUITY INDEX FUNDS",
    as_of: "2026-07-31",
    filed_at: "2026-09-28",
    lag_days: 59,
    source: "SEC N-PORT",
    source_url: "https://www.sec.gov/Archives/edgar/data/857489/example.xml",
    coverage_pct: 97.8,
    holdings,
    metrics: { hhi: 0, hhi_pct2: 0, effective_n: 0, top10_pct: 0 },
    warnings: [],
    ...overrides,
  };
}

describe("benchmarkFor", () => {
  it("converts basis points of the benchmark's NAV into fractions", () => {
    // 406 bp of NAV = 0.0406 of the fund. The number the table prints for NVDA is
    // 4.06%, which is 406/10,000 and nothing else.
    const benchmark = benchmarkFor(document([holding("c_nvda", 406)]));
    expect(benchmark.weights.c_nvda).toBeCloseTo(0.0406, 12);
  });

  it("sums two filed rows for one issuer into one weight", () => {
    // 200 bp + 100 bp of the same company is 0.03, counted once — the same rollup
    // rule the portfolio's ledger uses, so the two columns cannot disagree about
    // what "one company" means.
    const benchmark = benchmarkFor(document([holding("c_x", 200), holding("c_x", 100)]));
    expect(benchmark.weights.c_x).toBeCloseTo(0.03, 12);
    expect(Object.keys(benchmark.weights)).toHaveLength(1);
  });

  it("drops unmapped and zero-weight rows instead of spreading their weight", () => {
    // Cash, derivatives and unresolved companies have no company to be weighed
    // against; a zero-bp row moves no money. Their weight stays in the benchmark's
    // uncovered `coverage_pct` and is never redistributed across the resolved ones.
    const benchmark = benchmarkFor(
      document([
        holding("c_x", 5000),
        holding(null, 3000, "cash"),
        holding(null, 2000),
        holding("c_zero", 0),
      ]),
    );
    expect(benchmark.weights).toEqual({ c_x: 0.5 });
  });

  it("carries the provenance the caption has to state", () => {
    const benchmark = benchmarkFor(document([holding("c_x", 100)]));
    expect(benchmark.ticker).toBe("VT");
    expect(benchmark.name).toBe("VANGUARD TOTAL WORLD STOCK INDEX FUND");
    expect(benchmark.as_of).toBe("2026-07-31");
    expect(benchmark.filed_at).toBe("2026-09-28");
    expect(benchmark.lag_days).toBe(59);
    expect(benchmark.coverage_pct).toBe(97.8);
    expect(benchmark.source_url).toContain("sec.gov");
  });
});

/**
 * Two producers, one payload.
 *
 * Since ADR-0015 §7 the page normally reads the compact object the release pre-rolled
 * instead of the benchmark's 1.58 MB fund document. That makes `benchmarkFromRollup`
 * a second path to a displayed number, and the risk is drift: the release validator
 * recomputes the rollup from the document, and this test recomputes the payload from
 * the rollup — so a reader gets the same column whichever object answered.
 */
describe("the compact object and the fund document agree", () => {
  function rollupOf(document: FundDocument): BenchmarkRollup {
    // The builder's rule, restated in the object's own units: integer basis points,
    // no unmapped rows, no zero rows, one entry per company.
    const weights: Record<string, number> = {};
    for (const holding of document.holdings) {
      if (!holding.company_id || holding.weight_bp === 0) continue;
      weights[holding.company_id] =
        (weights[holding.company_id] ?? 0) + holding.weight_bp;
    }
    return {
      schema_version: 1,
      kind: "benchmark",
      ticker: document.ticker,
      fund_id: document.fund_id,
      name: document.name,
      as_of: document.as_of,
      filed_at: document.filed_at,
      lag_days: document.lag_days,
      coverage_pct: document.coverage_pct,
      source_url: document.source_url,
      weights,
    };
  }

  it("produces the same weights and provenance from either object", () => {
    const filing = document([
      holding("c_a", 700),
      holding("c_a", 300),
      holding("c_b", 1),
      holding(null, 900),
      holding("c_zero", 0),
    ]);
    expect(benchmarkFromRollup(rollupOf(filing))).toEqual(benchmarkFor(filing));
  });

  it("divides by gross weight once, in basis points", () => {
    const filing = document([holding("c_a", 406)]);
    const payload = benchmarkFromRollup(rollupOf(filing));
    // 406 bp of a 10,000 bp allocation: 4.06%, the number the table shows.
    expect(payload.weights.c_a).toBeCloseTo(0.0406, 10);
  });
});

describe("benchmarkDelta", () => {
  it("is your weight minus the benchmark's, on the operator's worked example", () => {
    // NVIDIA in the screenshot: 1.52% of the portfolio, 4.06% of VT.
    expect(benchmarkDelta(0.0152, 0.0406)).toBeCloseTo(-0.0254, 12);
  });

  it("is positive when you hold more of the company than the benchmark does", () => {
    expect(benchmarkDelta(0.06, 0.0406)).toBeCloseTo(0.0194, 12);
  });

  it("is the whole of your weight when the benchmark holds none of it", () => {
    // AVUV's small caps: absent from VT's traced holdings reads 0.00%, and the
    // difference is therefore your own weight rather than a comparison.
    expect(benchmarkDelta(0.003, 0)).toBeCloseTo(0.003, 12);
  });

  it("has no value without a benchmark, because there is nothing to difference", () => {
    expect(benchmarkDelta(0.0152, null)).toBeNull();
  });
});
