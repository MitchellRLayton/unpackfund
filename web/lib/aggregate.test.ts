import { describe, expect, it } from "vitest";

import { buildLedger } from "./aggregate";
import { BENCHMARK_TICKER, benchmarkFor } from "./benchmark";
import type { FundDocument, Holding } from "./types";

/**
 * The fixture numbers are worked out by hand in the comments, per
 * `lookthrough-math-and-qa` §8: a fixture the test author cannot verify on paper
 * only proves the implementation agrees with itself.
 */

function fund(input: {
  ticker: string;
  holdings?: Holding[];
  coverage_pct?: number;
  as_of?: string;
  filed_at?: string;
  lag_days?: number;
}): FundDocument {
  return {
    schema_version: 1,
    ticker: input.ticker,
    fund_id: `S${input.ticker}`,
    name: `${input.ticker} Fund`,
    issuer: "Issuer",
    as_of: input.as_of ?? "2026-06-30",
    filed_at: input.filed_at ?? "2026-08-28",
    lag_days: input.lag_days ?? 59,
    source: "SEC N-PORT",
    source_url: `https://www.sec.gov/${input.ticker}`,
    coverage_pct: input.coverage_pct ?? 100,
    holdings: input.holdings ?? [],
    metrics: { hhi: 0, hhi_pct2: 0, effective_n: 0, top10_pct: 0 },
    warnings: [],
  };
}

const holding = (
  company_id: string | null,
  weight_bp: number,
  ticker: string | null = null,
  asset_cat: Holding["asset_cat"] = "equity",
): Holding => ({
  company_id,
  name: `Company ${company_id ?? "unmapped"}`,
  ticker,
  asset_cat,
  weight_bp,
});

describe("buildLedger", () => {
  // A: 50% weight. X 5000bp, Y 3000bp, cash 2000bp (unmapped).
  // B: 50% weight. X 2000bp, Z 8000bp, coverage 100%.
  // X = 0.5·0.50 + 0.5·0.20 = 0.250 + 0.100 = 0.350
  // Y = 0.5·0.30 = 0.150
  // Z = 0.5·0.80 = 0.400
  // HHI = 0.35² + 0.15² + 0.40² = 0.1225 + 0.0225 + 0.16 = 0.305 → effective N = 3.2787
  // top 10 = 0.35 + 0.15 + 0.40 = 0.90
  const a = fund({
    ticker: "A",
    holdings: [holding("c_x", 5000, "X"), holding("c_y", 3000, "Y"), holding(null, 2000)],
  });
  const b = fund({
    ticker: "B",
    holdings: [holding("c_x", 2000, "X"), holding("c_z", 8000, "Z")],
  });

  it("computes the look-through weights by hand", () => {
    const ledger = buildLedger({ funds: [a, b], weightsBp: { A: 5000, B: 5000 } });
    const byId = Object.fromEntries(ledger.rows.map((row) => [row.company_id, row]));

    expect(ledger.rows).toHaveLength(3);
    expect(byId.c_x?.weight).toBeCloseTo(0.35, 12);
    expect(byId.c_y?.weight).toBeCloseTo(0.15, 12);
    expect(byId.c_z?.weight).toBeCloseTo(0.4, 12);
    expect(byId.c_x?.fund_count).toBe(2);
    expect(byId.c_x?.sources).toEqual([
      { ticker: "A", weight: 0.25 },
      { ticker: "B", weight: 0.1 },
    ]);
  });

  it("derives concentration from the summed weights, never fund by fund", () => {
    const ledger = buildLedger({ funds: [a, b], weightsBp: { A: 5000, B: 5000 } });
    expect(ledger.metrics.hhi).toBeCloseTo(0.305, 12);
    expect(ledger.metrics.effective_n).toBeCloseTo(1 / 0.305, 10);
    expect(ledger.metrics.top10).toBeCloseTo(0.9, 12);
  });

  it("counts the unmapped holding and never redistributes it", () => {
    const ledger = buildLedger({ funds: [a, b], weightsBp: { A: 5000, B: 5000 } });
    expect(ledger.unmapped.positions).toBe(1);
    // 100% weight resolved: A's 2000bp cash row is unmapped but A reports 100%
    // coverage in this fixture, so the disclosed number is used as filed.
    expect(ledger.metrics.covered_weight_pct).toBeCloseTo(100, 10);
  });

  it("separates the uncovered gap by cause and by weight", () => {
    // F at 50%: X 5000bp mapped; unmatched equity 3000bp; unmatched cash 1000bp;
    //          unmatched equity 0bp (rounds to nothing).
    // G at 50%: Z 10000bp mapped.
    // Securities gap = 0.5 × 0.30 = 0.15. Cash gap = 0.5 × 0.10 = 0.05.
    // Three unmatched positions; two of them carry weight.
    const f = fund({
      ticker: "F",
      holdings: [
        holding("c_x", 5000, "X"),
        holding(null, 3000),
        holding(null, 1000, null, "cash"),
        holding(null, 0),
      ],
    });
    const g = fund({ ticker: "G", holdings: [holding("c_z", 10000, "Z")] });
    const ledger = buildLedger({ funds: [f, g], weightsBp: { F: 5000, G: 5000 } });

    expect(ledger.unmapped.positions).toBe(3);
    expect(ledger.unmapped.positions_with_weight).toBe(2);
    expect(ledger.unmapped.securities_with_weight).toBe(1);
    expect(ledger.unmapped.securities_weight).toBeCloseTo(0.15, 12);
    expect(ledger.unmapped.cash_and_derivatives_with_weight).toBe(1);
    expect(ledger.unmapped.cash_and_derivatives_weight).toBeCloseTo(0.05, 12);
    // The gap is disclosed, not spread over X and Z: their weights are unchanged.
    const byId = Object.fromEntries(ledger.rows.map((row) => [row.company_id, row]));
    expect(byId.c_x?.weight).toBeCloseTo(0.25, 12);
    expect(byId.c_z?.weight).toBeCloseTo(0.5, 12);
  });

  it("sums share classes of one issuer exactly once", () => {
    // Two rows, same company_id, one fund: 0.10 + 0.05 at 100% weight.
    const withShareClasses = fund({
      ticker: "C",
      holdings: [
        holding("c_x", 1000, "X"),
        holding("c_x", 500, "X"),
        holding("c_y", 500, "Y"),
      ],
    });
    const ledger = buildLedger({ funds: [withShareClasses], weightsBp: { C: 10000 } });
    const x = ledger.rows.find((row) => row.company_id === "c_x");
    expect(x?.weight).toBeCloseTo(0.15, 12);
    expect(x?.fund_count).toBe(1);
    expect(ledger.rows).toHaveLength(2);
  });

  it("drops zero-weight holdings without dropping the company", () => {
    const zero = fund({
      ticker: "D",
      holdings: [holding("c_x", 0), holding("c_y", 10000)],
    });
    const ledger = buildLedger({ funds: [zero], weightsBp: { D: 10000 } });
    expect(ledger.rows.map((row) => row.company_id)).toEqual(["c_y"]);
  });

  it("excludes a short from concentration but keeps the exposure visible", () => {
    const shorted = fund({
      ticker: "E",
      holdings: [holding("c_x", 6000), holding("c_y", 4000), holding("c_short", -1000)],
    });
    const ledger = buildLedger({ funds: [shorted], weightsBp: { E: 10000 } });
    expect(ledger.rows.find((row) => row.company_id === "c_short")?.weight).toBeCloseTo(
      -0.1,
      12,
    );
    expect(ledger.metrics.hhi).toBeCloseTo(0.36 + 0.16, 12);
  });

  it("normalises coverage by the funds actually present", () => {
    // One fund at 5000bp with 70% coverage: the mean coverage is 70, not 35.
    const partial = fund({
      ticker: "F",
      coverage_pct: 70,
      holdings: [holding("c_x", 10000)],
    });
    const ledger = buildLedger({ funds: [partial], weightsBp: { F: 5000 } });
    expect(ledger.metrics.covered_weight_pct).toBeCloseTo(70, 10);
    expect(ledger.metrics.resolved_weight).toBeCloseTo(0.5, 12);
  });

  it("reports the oldest filing period and the longest lag", () => {
    const old = fund({
      ticker: "G",
      as_of: "2026-03-31",
      filed_at: "2026-05-20",
      lag_days: 50,
    });
    const newer = fund({
      ticker: "H",
      as_of: "2026-06-30",
      filed_at: "2026-08-28",
      lag_days: 59,
    });
    const ledger = buildLedger({ funds: [old, newer], weightsBp: { G: 5000, H: 5000 } });
    expect(ledger.oldest_as_of).toBe("2026-03-31");
    expect(ledger.max_lag_days).toBe(59);
  });

  it("skips a fund with no allocation instead of zero-weighting it", () => {
    const ledger = buildLedger({ funds: [a, b], weightsBp: { A: 10000, B: 0 } });
    expect(ledger.funds.map((entry) => entry.ticker)).toEqual(["A"]);
    expect(ledger.rows.every((row) => row.fund_count === 1)).toBe(true);
  });

  it("is deterministic: same input, same order, tie broken by company id", () => {
    const tied = fund({
      ticker: "I",
      holdings: [holding("c_b", 5000), holding("c_a", 5000)],
    });
    const first = buildLedger({ funds: [tied], weightsBp: { I: 10000 } });
    const second = buildLedger({ funds: [tied], weightsBp: { I: 10000 } });
    expect(first.rows.map((row) => row.company_id)).toEqual(["c_a", "c_b"]);
    expect(second.rows).toEqual(first.rows);
  });

  it("says not computable rather than zero when there is nothing to measure", () => {
    const empty = fund({ ticker: "J", holdings: [] });
    const ledger = buildLedger({ funds: [empty], weightsBp: { J: 10000 } });
    expect(ledger.rows).toEqual([]);
    expect(ledger.metrics.hhi).toBeNull();
    expect(ledger.metrics.effective_n).toBeNull();
    expect(ledger.metrics.top10).toBeNull();
  });

  it("marks a fund below 60% as suppressed weight", () => {
    const thin = fund({
      ticker: "K",
      coverage_pct: 41,
      holdings: [holding("c_x", 10000)],
    });
    const ledger = buildLedger({ funds: [thin], weightsBp: { K: 10000 } });
    expect(ledger.metrics.suppressed_weight).toBeCloseTo(1, 12);
  });
});

describe("the benchmark column", () => {
  // Portfolio: A at 50% holds X 2000bp and Y 3000bp; B at 50% holds X 1000bp and
  // Z 5000bp.
  //   X = 0.5·0.20 + 0.5·0.10 = 0.10 + 0.05 = 0.15
  //   Y = 0.5·0.30 = 0.15
  //   Z = 0.5·0.50 = 0.25
  // Benchmark: X 406bp = 0.0406, Y 100bp = 0.01, and W 900bp — a company the
  // portfolio holds no part of, so W must not appear as a ledger row.
  const p1 = fund({
    ticker: "A",
    holdings: [holding("c_x", 2000, "X"), holding("c_y", 3000, "Y")],
  });
  const p2 = fund({
    ticker: "B",
    holdings: [holding("c_x", 1000, "X"), holding("c_z", 5000, "Z")],
  });
  const benchmark = benchmarkFor(
    fund({
      ticker: BENCHMARK_TICKER,
      as_of: "2026-07-31",
      coverage_pct: 97.8,
      holdings: [
        holding("c_x", 406, "X"),
        holding("c_y", 100, "Y"),
        holding("c_w", 900, "W"),
      ],
    }),
  );

  it("puts each company's benchmark weight beside its portfolio weight", () => {
    const ledger = buildLedger({
      funds: [p1, p2],
      weightsBp: { A: 5000, B: 5000 },
      benchmark,
    });
    const byId = Object.fromEntries(ledger.rows.map((row) => [row.company_id, row]));

    expect(byId.c_x?.benchmark_weight).toBeCloseTo(0.0406, 12);
    expect(byId.c_y?.benchmark_weight).toBeCloseTo(0.01, 12);
    // The portfolio's own arithmetic is untouched by the comparison.
    expect(byId.c_x?.weight).toBeCloseTo(0.15, 12);
    expect(byId.c_y?.weight).toBeCloseTo(0.15, 12);
    expect(byId.c_z?.weight).toBeCloseTo(0.25, 12);
  });

  it("reports a company the benchmark does not hold as a true zero", () => {
    // Z is 25% of this portfolio and 0 bp of VT. A zero here is a fact about the
    // benchmark's filing, not a missing value — see the next test for that.
    const ledger = buildLedger({
      funds: [p1, p2],
      weightsBp: { A: 5000, B: 5000 },
      benchmark,
    });
    const z = ledger.rows.find((row) => row.company_id === "c_z");
    expect(z?.benchmark_weight).toBe(0);
  });

  it("never turns a missing benchmark into a column of zeros", () => {
    const ledger = buildLedger({ funds: [p1, p2], weightsBp: { A: 5000, B: 5000 } });
    expect(ledger.benchmark).toBeNull();
    expect(ledger.rows.every((row) => row.benchmark_weight === null)).toBe(true);
  });

  it("keeps the benchmark's provenance and leaves its weights behind", () => {
    const ledger = buildLedger({
      funds: [p1, p2],
      weightsBp: { A: 5000, B: 5000 },
      benchmark,
    });
    expect(ledger.benchmark).toEqual({
      ticker: "VT",
      name: `${BENCHMARK_TICKER} Fund`,
      as_of: "2026-07-31",
      filed_at: "2026-08-28",
      lag_days: 59,
      coverage_pct: 97.8,
      source_url: `https://www.sec.gov/${BENCHMARK_TICKER}`,
    });
    // The rows carry the per-company value; ~6,900 weights must not ride along.
    expect(ledger.benchmark).not.toHaveProperty("weights");
  });
});
