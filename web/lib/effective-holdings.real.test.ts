/**
 * Core against the fund page's own number.
 *
 * The release publishes `metrics.effective_n = 1/Σwᵢ²` with no renormalisation ("NAV, as
 * filed" — `pipeline/pipeline/weights.py`), and the generated fund page prints it as
 * "Same-size companies". The brief requires Core to be reused rather than reimplemented,
 * and this file is where the two are tied together: they are the same arithmetic with two
 * denominators, so `effective_n = Core / T²` exactly, and the pair coincide only when the
 * fund resolves 100% of itself to companies.
 *
 * Writing the relationship down is the point. A reader who sees 157.5 in one place and
 * 129.9 in another deserves a line of code that says the first is the second over T², not
 * two implementations agreeing by luck.
 */

import { describe, expect, it } from "vitest";

import { effectiveHoldingsForFund } from "./effective-holdings";
import type { FundDocument, Holding } from "./types";

function holding(
  name: string,
  companyId: string | null,
  weightBp: number,
  assetCat: Holding["asset_cat"] = "equity",
): Holding {
  return {
    name,
    ticker: null,
    company_id: companyId,
    weight_bp: weightBp,
    asset_cat: assetCat,
  };
}

function fund(holdings: Holding[], coveragePct = 100): FundDocument {
  return {
    schema_version: 1,
    ticker: "TEST",
    fund_id: "STEST",
    name: "Test Fund",
    issuer: "Issuer",
    as_of: "2026-06-30",
    filed_at: "2026-08-28",
    lag_days: 59,
    source: "SEC N-PORT",
    source_url: "https://www.sec.gov/test",
    coverage_pct: coveragePct,
    holdings,
  } as FundDocument;
}

/** The fund page's own figure: `1/Σwᵢ²` over positive company weights, no renormalising. */
function asFiledEffectiveN(holdings: readonly Holding[]): number {
  const weights = holdings
    .filter((row) => row.company_id && row.weight_bp > 0)
    .map((row) => row.weight_bp / 10_000);
  return 1 / weights.reduce((sum, weight) => sum + weight * weight, 0);
}

describe("Core against the fund page's as-filed figure", () => {
  const cases: Array<{ name: string; holdings: Holding[]; coverage: number }> = [
    {
      name: "a fully resolved fund",
      holdings: [
        holding("X", "c_x", 5000),
        holding("Y", "c_y", 3000),
        holding("Z", "c_z", 2000),
      ],
      coverage: 100,
    },
    {
      name: "a fund with 0.7% cash",
      holdings: [
        holding("X", "c_x", 5000),
        holding("Y", "c_y", 3000),
        holding("Z", "c_z", 1930),
        holding("Cash", null, 70, "cash"),
      ],
      coverage: 99.3,
    },
    {
      name: "a fund with an unresolved security",
      holdings: [
        holding("X", "c_x", 5000),
        holding("Y", "c_y", 3000),
        holding("Something undated", null, 500),
        holding("Cash", null, 1500, "cash"),
      ],
      coverage: 85,
    },
  ];

  for (const item of cases) {
    it(`${item.name}: effective_n = Core / T²`, () => {
      const effective = effectiveHoldingsForFund(fund(item.holdings, item.coverage));
      const asFiled = asFiledEffectiveN(item.holdings);
      const t = effective.matchedWeight;

      expect(effective.core).not.toBeNull();
      // The identity, to twelve places: same arithmetic, two denominators.
      expect(effective.core! / (t * t)).toBeCloseTo(asFiled, 12);
    });
  }

  it("they agree exactly when the fund resolves all of itself", () => {
    const holdings = [holding("X", "c_x", 5000), holding("Y", "c_y", 5000)];
    const effective = effectiveHoldingsForFund(fund(holdings, 100));

    expect(effective.matchedWeight).toBeCloseTo(1, 12);
    expect(effective.core!).toBeCloseTo(asFiledEffectiveN(holdings), 12);
  });

  it("cash does not lower coverage; an unresolved security does", () => {
    // Cash is outside both T and Q (`lookthrough-math-and-qa` §5, fixture 7): a holder who
    // keeps half a fund in cash still owns the same companies through it.
    const withCash = effectiveHoldingsForFund(
      fund([holding("X", "c_x", 5000), holding("Cash", null, 5000, "cash")], 50),
    );
    expect(withCash.coveragePct).toBeCloseTo(100, 12);
    expect(withCash.band).toBe("full");
    expect(withCash.core).toBeCloseTo(1, 12);

    // A security the release could not name is company-like money that did not resolve, so
    // it does lower coverage — here to 50%, which withholds both counts.
    const unresolved = effectiveHoldingsForFund(
      fund([holding("X", "c_x", 5000), holding("Unnamed", null, 5000)], 50),
    );
    expect(unresolved.coveragePct).toBeCloseTo(50, 12);
    expect(unresolved.band).toBe("none");
    expect(unresolved.core).toBeNull();
    expect(unresolved.broad).toBeNull();
  });
});
