/**
 * The style gate and the composite builder, checked against the plan's own worked
 * examples (`equity-style-benchmark-plan.md` §6 and §10).
 *
 * These are the tests that decide whether the feature is allowed to render at all, so
 * they are written from the plan's table rather than from the implementation: if the two
 * disagree, the plan is right and the code is the bug.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_MEMBER_LAG_DAYS,
  MIN_FUND_WEIGHT,
  activeShare,
  blendWeights,
  compositeFromDocuments,
  resolveStyleBenchmark,
  type ClassBenchmark,
  type PortfolioFund,
  type RegionMix,
} from "./style-benchmark";
import { STYLE_CLASS_BY_ID, classOf } from "./style-registry";
import type { AssetCategory, FundDocument, Holding } from "./types";

const US: RegionMix = { us: 0.99, dm: 0.0, em: 0.0, unplaced: 0.01 };
const INTL: RegionMix = { us: 0.02, dm: 0.95, em: 0.0, unplaced: 0.03 };
const EM: RegionMix = { us: 0.01, dm: 0.02, em: 0.96, unplaced: 0.01 };
/** A US-tagged fund whose holdings are mostly Japanese — a tagging mistake. */
const MISTAGGED: RegionMix = { us: 0.05, dm: 0.92, em: 0.0, unplaced: 0.03 };

/**
 * A fund's regional mix, defaulting to a plausible one *for the region its class sits in*:
 * a 98%-US default would fail every international fund on the purity check, which is a
 * test bug that looks exactly like a gate bug.
 */
function defaultMix(ticker: string): RegionMix {
  const region = classOf(ticker.toUpperCase())?.region;
  if (region === "INTL") return INTL;
  if (region === "EM") return EM;
  return US;
}

function gate(
  funds: PortfolioFund[],
  mixes: Record<string, RegionMix> = {},
  requireSingleRegion = false,
) {
  return resolveStyleBenchmark(funds, {
    regionMix: (ticker) => mixes[ticker.toUpperCase()] ?? defaultMix(ticker),
    requireSingleRegion,
  });
}

function fund(ticker: string, weight: number): PortfolioFund {
  return { ticker, weight };
}

/** A fund document with just enough shape for the composite builder. */
function document(
  ticker: string,
  holdings: [string | null, number][],
  overrides: Partial<FundDocument> = {},
): FundDocument {
  return {
    schema_version: 2,
    ticker,
    fund_id: `f_${ticker}`,
    name: `${ticker} fund`,
    issuer: "test",
    as_of: "2026-09-30",
    filed_at: "2026-10-30",
    lag_days: 30,
    source: "N-PORT",
    source_url: "https://example.invalid",
    coverage_pct: 99.5,
    holdings: holdings.map(([company, weight]) => ({
      company_id: company,
      name: company ?? "cash",
      ticker: null,
      asset_cat: "equity" as AssetCategory,
      weight_bp: weight,
    })) satisfies Holding[],
    // The composite builder reads holdings and coverage only; the metrics are inert here.
    metrics: { hhi: 0, hhi_pct2: 0, effective_n: 0, top10_pct: 0 },
    warnings: [],
    ...overrides,
  };
}

// -- §6 the gate, one row per worked example ----------------------------------
describe("the gate's worked examples", () => {
  it("SPMO 50 / MTUM 50 is US momentum, one class at 100%", () => {
    const result = gate([fund("SPMO", 0.5), fund("MTUM", 0.5)]);
    expect(result).toEqual({
      eligible: true,
      family: "momentum",
      classes: [{ classId: "US_MOM_LARGE", alloc: 1 }],
      single: true,
    });
  });

  it("SPMO 50 / XSMO 50 is a two-class momentum blend", () => {
    const result = gate([fund("SPMO", 0.5), fund("XSMO", 0.5)]);
    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    expect(result.family).toBe("momentum");
    expect(result.classes).toEqual([
      { classId: "US_MOM_LARGE", alloc: 0.5 },
      { classId: "US_MOM_SMID", alloc: 0.5 },
    ]);
    expect(result.single).toBe(false);
  });

  it("SPMO 70 / IMTM 30 blends US and international momentum, and the region flag can veto it", () => {
    const result = gate([fund("SPMO", 0.7), fund("IMTM", 0.3)]);
    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    expect(result.classes).toEqual([
      { classId: "US_MOM_LARGE", alloc: 0.7 },
      { classId: "INTL_MOM", alloc: 0.3 },
    ]);

    const restricted = gate([fund("SPMO", 0.7), fund("IMTM", 0.3)], {}, true);
    expect(restricted.eligible).toBe(false);
    if (restricted.eligible) return;
    expect(restricted.reason).toBe("mixed_family");
  });

  it("AVUV 60 / AVDV 40 is a two-class value blend the plan wants shown", () => {
    const result = gate([fund("AVUV", 0.6), fund("AVDV", 0.4)]);
    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    expect(result.family).toBe("value");
    expect(result.classes).toEqual([
      { classId: "US_SCV", alloc: 0.6 },
      { classId: "INTL_SCV", alloc: 0.4 },
    ]);
  });

  it("AVUV 50 / VB 50 is hidden: value and size are different families", () => {
    const result = gate([fund("AVUV", 0.5), fund("VB", 0.5)]);
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe("mixed_family");
    expect(result.offenders).toEqual(["US Small Cap Value", "US Small Caps"]);
  });

  it("AVUV 80 / DFAC 20 is hidden: DFAC is untagged, and unclassified outranks mixed family", () => {
    const result = gate([fund("AVUV", 0.8), fund("DFAC", 0.2)]);
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe("unclassified");
    expect(result.offenders).toEqual(["DFAC"]);
  });

  it("an empty portfolio has no style benchmark", () => {
    const result = gate([]);
    expect(result).toEqual({ eligible: false, reason: "empty", offenders: [] });
  });
});

// -- §6 the gate's arithmetic and its edges ----------------------------------
describe("the gate's edges", () => {
  it("ignores a fund below 0.01% of the portfolio", () => {
    // DFAC is untagged, so it would fail the gate — but at 0.005% it is not looked at.
    const result = gate([fund("AVUV", 0.99995), fund("DFAC", 0.00005)]);
    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    expect(result.classes).toEqual([{ classId: "US_SCV", alloc: 1 }]);
  });

  it("keeps a fund exactly at the 0.01% threshold", () => {
    const result = gate([
      fund("AVUV", 1 - MIN_FUND_WEIGHT),
      fund("DFAC", MIN_FUND_WEIGHT),
    ]);
    expect(result.eligible).toBe(false);
  });

  it("alloc sums to 1 across three classes however the weights are split", () => {
    const result = gate([fund("SPMO", 0.2), fund("XSMO", 0.3), fund("IMTM", 0.5)]);
    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    const total = result.classes.reduce((sum, entry) => sum + entry.alloc, 0);
    expect(total).toBeCloseTo(1, 12);
  });

  it("hides a fund whose look-through is not mostly in its class's region", () => {
    const result = gate([fund("AVUV", 1)], { AVUV: MISTAGGED });
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe("region_fail");
    expect(result.offenders).toEqual(["AVUV (5% US)"]);
  });

  it("accepts an international fund that clears the 90% developed threshold", () => {
    const result = gate([fund("AVDV", 1)], { AVDV: INTL });
    expect(result.eligible).toBe(true);
  });

  it("accepts an EM fund at 96% EM", () => {
    const result = gate([fund("EEMS", 1)], { EEMS: EM });
    expect(result.eligible).toBe(true);
  });

  it("does not fail a fund whose region mix has not arrived yet", () => {
    const result = resolveStyleBenchmark([fund("AVUV", 1)], { regionMix: () => null });
    expect(result.eligible).toBe(true);
  });

  it("EFV alone is the benchmark, so the plan's 'you hold it' state applies", () => {
    const result = gate([fund("EFV", 1)], { EFV: INTL });
    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    expect(result.classes).toEqual([{ classId: "INTL_LARGE_VALUE", alloc: 1 }]);
    // One member, and the reader holds exactly it: the blend equals the reader's book.
    const composite = compositeFromDocuments("INTL_LARGE_VALUE", [
      document(
        "EFV",
        [
          ["c_1", 6000],
          ["c_2", 3900],
        ],
        { coverage_pct: 99 },
      ),
    ]);
    expect(activeShare({ c_1: 0.6, c_2: 0.39 }, composite.weights)).toBeCloseTo(0, 12);
  });
});

// -- §7 the composite builder -------------------------------------------------
describe("the composite builder", () => {
  it("equal-weights two members and rolls a company held by both into one row", () => {
    const composite = compositeFromDocuments("US_SCV", [
      document("VBR", [
        ["c_1", 5000],
        ["c_2", 5000],
      ]),
      document("IJS", [
        ["c_1", 2500],
        ["c_3", 7500],
      ]),
    ]);

    // c_1 = (0.50 + 0.25) / 2, c_2 = 0.50 / 2, c_3 = 0.75 / 2.
    expect(composite.weights["c_1"]).toBeCloseTo(0.375, 12);
    expect(composite.weights["c_2"]).toBeCloseTo(0.25, 12);
    expect(composite.weights["c_3"]).toBeCloseTo(0.375, 12);
    expect(Object.keys(composite.weights).sort()).toEqual(["c_1", "c_2", "c_3"]);
    expect(composite.members.map((member) => member.ticker)).toEqual(["VBR", "IJS"]);
  });

  it("sums to the members' mean coverage, not to 1", () => {
    const composite = compositeFromDocuments("US_SCV", [
      document("VBR", [["c_1", 5000]], { coverage_pct: 99 }),
      document("IJS", [["c_1", 4000]], { coverage_pct: 98 }),
    ]);
    const total = Object.values(composite.weights).reduce(
      (sum, weight) => sum + weight,
      0,
    );
    expect(total).toBeCloseTo((0.5 + 0.4) / 2, 12);
  });

  it("a single-ETF class is that fund's own look-through", () => {
    const composite = compositeFromDocuments("EM", [
      document("IEMG", [
        ["c_1", 3000],
        ["c_2", 2000],
      ]),
    ]);
    expect(composite.weights).toEqual({ c_1: 0.3, c_2: 0.2 });
    expect(composite.members).toEqual([
      { ticker: "IEMG", asOf: "2026-09-30", coveragePct: 99.5 },
    ]);
  });

  it("drops a member whose filing is more than 120 days older than the newest", () => {
    const composite = compositeFromDocuments("US_SCV", [
      document("VBR", [["c_1", 5000]], { as_of: "2026-09-30" }),
      document("IJS", [["c_2", 5000]], { as_of: "2026-01-01" }),
    ]);
    // 2026-01-01 is 272 days older than 2026-09-30: stale, so the composite is VBR alone.
    // IWN is reported missing as well — the registry names three members and only two exist.
    expect(composite.weights).toEqual({ c_1: 0.5 });
    expect(composite.dropped).toEqual([
      { ticker: "IWN", why: "missing" },
      { ticker: "IJS", why: "stale" },
    ]);
  });

  it("keeps a member that is exactly at the lag limit", () => {
    const newest = "2026-09-30";
    const boundary = new Date(
      Date.parse(`${newest}T00:00:00Z`) - MAX_MEMBER_LAG_DAYS * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const composite = compositeFromDocuments("US_SCV", [
      document("VBR", [["c_1", 5000]], { as_of: newest }),
      document("IJS", [["c_2", 5000]], { as_of: boundary }),
    ]);
    expect(composite.dropped.filter((drop) => drop.why === "stale")).toEqual([]);
    expect(Object.keys(composite.weights).sort()).toEqual(["c_1", "c_2"]);
  });

  it("reports a member the release could not supply rather than averaging over the rest silently", () => {
    const composite = compositeFromDocuments("US_SCV", [
      document("VBR", [["c_1", 5000]]),
    ]);
    expect(composite.dropped).toEqual([
      { ticker: "IJS", why: "missing" },
      { ticker: "IWN", why: "missing" },
    ]);
    expect(composite.members.map((member) => member.ticker)).toEqual(["VBR"]);
  });

  it("publishes nothing when no member is available", () => {
    const composite = compositeFromDocuments("US_SCV", []);
    expect(composite.weights).toEqual({});
    expect(composite.asOf).toBeNull();
    expect(composite.members).toEqual([]);
  });
});

// -- §6 the blend, and §1 active share ---------------------------------------
describe("the blend and active share", () => {
  const us = compositeFromDocuments("US_MOM_LARGE", [document("SPMO", [["c_us", 5000]])]);
  const intl = compositeFromDocuments("INTL_MOM", [document("IMTM", [["c_intl", 5000]])]);

  it("blends two classes by allocation", () => {
    const blended = blendWeights(
      [
        { classId: "US_MOM_LARGE", alloc: 0.7 },
        { classId: "INTL_MOM", alloc: 0.3 },
      ],
      new Map<string, ClassBenchmark>([
        ["US_MOM_LARGE", us],
        ["INTL_MOM", intl],
      ]),
    );
    expect(blended["c_us"]).toBeCloseTo(0.35, 12);
    expect(blended["c_intl"]).toBeCloseTo(0.15, 12);
  });

  it("is 100% for a book that shares nothing with its benchmark", () => {
    expect(activeShare({ a: 1 }, { b: 1 })).toBeCloseTo(1, 12);
  });

  it("is 0 for a book that is its benchmark", () => {
    expect(activeShare({ a: 0.5, b: 0.5 }, { a: 0.5, b: 0.5 })).toBeCloseTo(0, 12);
  });

  it("counts a company only one side holds in full", () => {
    // |0.6-0.4| + |0.4-0.6| = 0.4, halved = 0.2.
    expect(activeShare({ a: 0.6, b: 0.4 }, { a: 0.4, b: 0.6 })).toBeCloseTo(0.2, 12);
  });

  it("ignores coverage the benchmark cannot place in a company", () => {
    // The benchmark's uncovered 1% is not a company, so it cannot create active share.
    expect(activeShare({ a: 1 }, { a: 0.99 })).toBeCloseTo(0.005, 12);
  });
});

// -- the registry itself ------------------------------------------------------
describe("the registry", () => {
  it("gives every class a family, a region and at least one member", () => {
    for (const styleClass of STYLE_CLASS_BY_ID.values()) {
      expect(styleClass.members.length).toBeGreaterThan(0);
      expect(["size", "value", "momentum"]).toContain(styleClass.family);
      expect(["US", "INTL", "EM"]).toContain(styleClass.region);
      for (const member of styleClass.members) {
        expect(member).toMatch(/^[A-Z]{2,5}$/);
      }
    }
  });

  it("tags every registered member with the class that lists it", () => {
    for (const styleClass of STYLE_CLASS_BY_ID.values()) {
      for (const member of styleClass.members) {
        expect(classOf(member)?.id).toBe(styleClass.id);
      }
    }
  });

  it("leaves an untagged ticker untagged", () => {
    expect(classOf("DFAC")).toBeNull();
    expect(classOf("VTI")).toBeNull();
  });
});
