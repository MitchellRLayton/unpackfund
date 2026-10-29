import { describe, expect, it } from "vitest";

import { buildLedger } from "./aggregate";
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
): Holding => ({
  company_id,
  name: `Company ${company_id ?? "unmapped"}`,
  ticker,
  asset_cat: "equity",
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
    expect(ledger.unmapped_holdings).toBe(1);
    // 100% weight resolved: A's 2000bp cash row is unmapped but A reports 100%
    // coverage in this fixture, so the disclosed number is used as filed.
    expect(ledger.metrics.covered_weight_pct).toBeCloseTo(100, 10);
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
