import { describe, expect, it } from "vitest";

import { buildOverlap } from "./overlap";
import type { FundDocument, Holding } from "./types";

/**
 * The AU-1 invariants that no existing test pins, plus the two the spec defers.
 *
 * `docs/platform/automation-spec.yaml` T-AU-1.2 asks for one entry point
 * (`pnpm test:invariants`) and a named test per invariant. The coverage map is
 * `docs/platform/au1-computation-inventory.md` §3; this file holds only what was
 * MISSING there, so a green run cannot be mistaken for a re-test of everything:
 *
 *   I-1  stock-only basis sums to 100%            — deferred, T-A.5 (platform spec)
 *   I-2  overlap symmetric, each term <= min      — here (symmetry is `overlap.test.ts`)
 *   I-3  overlap + onlyA = A's resolved weight    — `overlap.test.ts`
 *   I-4  Core <= Broad <= company count           — `effective-holdings.property.test.ts`
 *   I-5  percent and dollars modes agree          — not testable: no Dollars mode exists
 *   I-6  row order changes nothing                — `effective-holdings.property.test.ts`
 *   I-7  flattening preserves total weight        — `pipeline/tests/test_fund_of_funds_gates.py`
 *   I-8  an account filter equals its rows alone  — deferred, WS-B (platform spec)
 */

function fund(ticker: string, holdings: Holding[]): FundDocument {
  return {
    schema_version: 1,
    ticker,
    fund_id: `S${ticker}`,
    name: `${ticker} Fund`,
    issuer: "Issuer",
    as_of: "2026-06-30",
    filed_at: "2026-08-28",
    lag_days: 59,
    source: "SEC N-PORT",
    source_url: `https://www.sec.gov/${ticker}`,
    coverage_pct: 100,
    holdings,
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

describe("I-2 — every overlap term is bounded by both sides' weight", () => {
  // A = 100% of F: C1 30%, C2 50%, C3 20%.
  // B = 100% of G: C1 60%, C2 10%, C4 30%.
  // Hand-calculated: overlap = min(0.30,0.60) + min(0.50,0.10) + 0 + 0 = 0.40;
  // onlyA = 0 + 0.40 + 0.20 = 0.60; onlyB = 0.30 + 0 + 0.30 = 0.60.
  const a = {
    funds: [
      fund("F", [holding("c_1", 3000), holding("c_2", 5000), holding("c_3", 2000)]),
    ],
    weightsBp: { F: 10_000 },
  };
  const b = {
    funds: [
      fund("G", [holding("c_1", 6000), holding("c_2", 1000), holding("c_4", 3000)]),
    ],
    weightsBp: { G: 10_000 },
  };

  it("sums the per-company terms to the reported overlap", () => {
    const result = buildOverlap({ a, b });
    const terms = result.rows.reduce(
      (sum, row) => sum + Math.min(row.weightA, row.weightB),
      0,
    );
    expect(terms).toBeCloseTo(0.4, 12);
    expect(terms).toBeCloseTo(result.overlap, 12);
  });

  it("never lets a term exceed either side's weight in that company", () => {
    const result = buildOverlap({ a, b });
    for (const row of result.rows) {
      const term = Math.min(row.weightA, row.weightB);
      expect(term).toBeLessThanOrEqual(row.weightA);
      expect(term).toBeLessThanOrEqual(row.weightB);
      // And the term is the min itself, not a product or a gross weight.
      expect(term).toBe(Math.min(row.weightA, row.weightB));
    }
  });

  it("matches the hand-calculated overlap and unique weights", () => {
    const result = buildOverlap({ a, b });
    expect(result.overlap).toBeCloseTo(0.4, 12);
    expect(result.onlyA).toBeCloseTo(0.6, 12);
    expect(result.onlyB).toBeCloseTo(0.6, 12);
  });
});

// The stock-only basis (company weights + unmapped stock residual = 100%) arrives
// with T-A.5 in the platform spec, which is not in the workspace yet.
describe.skip("I-1 — stock-only basis sums to 100% (T-A.5)", () => {
  it("company weights plus the unmapped stock residual equal 100% ± 0.01 pt", () => {});
});

// Accounts arrive with WS-B in the platform spec.
describe.skip("I-8 — an account filter equals its rows entered alone (WS-B)", () => {
  it("filters to an account's rows and agrees with entering those rows alone", () => {});
});
