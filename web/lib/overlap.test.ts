import { describe, expect, it } from "vitest";

import { buildOverlap } from "./overlap";
import type { FundDocument, Holding } from "./types";

/**
 * Hand-worked fixtures, per `lookthrough-math-and-qa` §8: a fixture the author
 * cannot verify on paper only proves the implementation agrees with itself.
 */

function fund(input: { ticker: string; holdings?: Holding[] }): FundDocument {
  return {
    schema_version: 1,
    ticker: input.ticker,
    fund_id: `S${input.ticker}`,
    name: `${input.ticker} Fund`,
    issuer: "Issuer",
    as_of: "2026-06-30",
    filed_at: "2026-08-28",
    lag_days: 59,
    source: "SEC N-PORT",
    source_url: `https://www.sec.gov/${input.ticker}`,
    coverage_pct: 100,
    holdings: input.holdings ?? [],
    metrics: { hhi: 0, hhi_pct2: 0, effective_n: 0, top10_pct: 0 },
    warnings: [],
  };
}

const holding = (company_id: string, weight_bp: number): Holding => ({
  company_id,
  name: `Company ${company_id}`,
  ticker: company_id.toUpperCase(),
  asset_cat: "equity",
  weight_bp,
});

describe("buildOverlap", () => {
  // A = 100% in fund F: X 5000bp, Y 5000bp.
  // B = 100% in fund G: X 2000bp, Z 8000bp.
  //   X = min(0.50, 0.20) = 0.20
  //   overlap = 0.20
  //   onlyA = (0.50 − 0.20) + 0.50 = 0.80   [X's excess plus all of Y]
  //   onlyB = (0.80 − 0.20) + 0     = 0.60 → no: Z is 0.80 against 0 on A's side,
  //           so onlyB = 0.80 − 0 = 0.80; X contributes nothing (A holds more).
  //   overlap + onlyA = 0.20 + 0.80 = 1.00 = A's resolved weight ✔
  //   overlap + onlyB = 0.20 + 0.80 = 1.00 = B's resolved weight ✔
  const a = {
    funds: [
      fund({ ticker: "F", holdings: [holding("c_x", 5000), holding("c_y", 5000)] }),
    ],
    weightsBp: { F: 10_000 },
  };
  const b = {
    funds: [
      fund({ ticker: "G", holdings: [holding("c_x", 2000), holding("c_z", 8000)] }),
    ],
    weightsBp: { G: 10_000 },
  };

  it("computes Σ min as the overlap, and each side's unique weight", () => {
    const result = buildOverlap({ a, b });
    expect(result.overlap).toBeCloseTo(0.2, 10);
    expect(result.onlyA).toBeCloseTo(0.8, 10);
    expect(result.onlyB).toBeCloseTo(0.8, 10);
    expect(result.sharedCount).toBe(1);
    expect(result.unionCount).toBe(3);
  });

  it("keeps the identity overlap + onlyA = A's resolved weight", () => {
    const result = buildOverlap({ a, b });
    expect(result.overlap + result.onlyA).toBeCloseTo(
      result.ledgerA.metrics.resolved_weight,
      10,
    );
    expect(result.overlap + result.onlyB).toBeCloseTo(
      result.ledgerB.metrics.resolved_weight,
      10,
    );
  });

  it("is symmetric in the overlap, and mirrors the unique weights", () => {
    const forward = buildOverlap({ a, b });
    const backward = buildOverlap({ a: b, b: a });
    expect(backward.overlap).toBeCloseTo(forward.overlap, 10);
    expect(backward.onlyA).toBeCloseTo(forward.onlyB, 10);
    expect(backward.onlyB).toBeCloseTo(forward.onlyA, 10);
  });

  it("rows carry the signed difference, and a company only one side holds is one-sided", () => {
    const result = buildOverlap({ a, b });
    const x = result.rows.find((row) => row.company_id === "c_x");
    const y = result.rows.find((row) => row.company_id === "c_y");
    const z = result.rows.find((row) => row.company_id === "c_z");
    expect(x).toMatchObject({ weightA: 0.5, weightB: 0.2, inBoth: true });
    expect(x?.delta).toBeCloseTo(0.3, 10);
    expect(y).toMatchObject({ weightA: 0.5, weightB: 0, inBoth: false });
    expect(z).toMatchObject({ weightA: 0, weightB: 0.8, inBoth: false });
  });

  it("sorts rows by the larger of the two weights", () => {
    const result = buildOverlap({ a, b });
    // Z 0.80 is the largest single weight, then X and Y at 0.50 — tie broken by id.
    const order = result.rows.map((row) => row.company_id);
    expect(order).toEqual(["c_z", "c_x", "c_y"]);
  });

  it("is zero overlap for two portfolios with no company in common", () => {
    const other = {
      funds: [fund({ ticker: "H", holdings: [holding("c_q", 10_000)] })],
      weightsBp: { H: 10_000 },
    };
    const result = buildOverlap({ a, b: other });
    expect(result.overlap).toBe(0);
    expect(result.sharedCount).toBe(0);
    expect(result.onlyA).toBeCloseTo(1, 10);
  });

  it("reports full overlap for the same portfolio twice", () => {
    const result = buildOverlap({ a, b: a });
    expect(result.overlap).toBeCloseTo(1, 10);
    expect(result.onlyA).toBe(0);
    expect(result.onlyB).toBe(0);
    expect(result.sharedCount).toBe(2);
  });

  it("does not let an unmapped holding become overlap", () => {
    // Cash is unmapped on one side; it cannot match anything on the other.
    const withCash = {
      funds: [
        fund({
          ticker: "F",
          holdings: [
            holding("c_x", 5000),
            { ...holding("c_x", 0), company_id: null, weight_bp: 5000 },
          ],
        }),
      ],
      weightsBp: { F: 10_000 },
    };
    const result = buildOverlap({ a: withCash, b });
    expect(result.overlap).toBeCloseTo(0.2, 10);
    expect(result.onlyA).toBeCloseTo(0.3, 10);
    expect(result.ledgerA.unmapped.positions).toBe(1);
  });
});
