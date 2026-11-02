import { describe, expect, it } from "vitest";

import { BENCHMARK_TICKER, benchmarkFor } from "./benchmark";
import type { FundDocument, Holding } from "./types";

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
