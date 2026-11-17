import { describe, expect, it } from "vitest";

import type { FundDocument, Ledger, LedgerRow } from "@/lib/types";
import type { WorkspaceModel } from "@/lib/use-workspace";

import { buildMetrics, COVERAGE_DOT_BELOW } from "./metrics";

/**
 * The strip replaced the "What you own" card, so these tests are the record of what the
 * card used to say and where each fact went. They assert the mapping, not the markup:
 * a number, the line under it, and the sentence a screen reader hears.
 */

function row(companyId: string, country: string | null, weight: number): LedgerRow {
  return {
    company_id: companyId,
    name: companyId.toUpperCase(),
    ticker: null,
    country,
    weight,
    benchmark_weight: null,
    holder_count: 1,
    held_directly: false,
    sources: [],
  };
}

function fund(ticker: string, holdings: [string, number][]): FundDocument {
  return {
    ticker,
    name: `${ticker} fund`,
    issuer: "test",
    as_of: "2026-06-30",
    filed_at: "2026-08-28",
    lag_days: 59,
    source: "N-PORT",
    source_url: "https://example.invalid",
    coverage_pct: 99,
    holdings: holdings.map(([companyId, weightBp]) => ({
      company_id: companyId,
      name: companyId.toUpperCase(),
      ticker: null,
      weight_bp: weightBp,
      country: "US",
    })),
    metrics: { hhi: 0, hhi_pct2: 0, effective_n: 0, top10_pct: 0 },
    warnings: [],
  } as unknown as FundDocument;
}

const VTI = fund("VTI", [
  ["c_apple", 4_000],
  ["c_msft", 3_000],
  ["c_nvda", 2_000],
]);
const VXUS = fund("VXUS", [
  ["c_apple", 2_000],
  ["c_nestle", 6_000],
]);

function ledgerAt(share: number): Ledger {
  const base = ledgerOf(99);
  return {
    ...base,
    rows: base.rows.map((row) => ({ ...row, weight: row.weight * share })),
  };
}

function ledgerOf(covered: number): Ledger {
  return {
    rows: [
      row("c_apple", "US", 0.4),
      row("c_msft", "US", 0.2),
      row("c_nvda", "US", 0.1),
      row("c_nestle", "CH", 0.3),
    ],
    metrics: {
      hhi: null,
      effective_n: null,
      top10: 0.7,
      covered_weight_pct: covered,
      resolved_weight: 1,
      suppressed_weight: 0,
      invested_weight: 1,
      cash_weight: 0,
      unallocated_weight: 0,
    },
    benchmark: null,
    funds: [
      {
        ticker: "VTI",
        name: "VTI fund",
        as_of: "2026-06-30",
        filed_at: "2026-08-28",
        lag_days: 59,
        coverage_pct: 99,
        source_url: "",
        identified_pct: 99,
        coverage_by_cat: {},
        identified_by_cat: {},
      },
      {
        ticker: "VXUS",
        name: "VXUS fund",
        as_of: "2026-06-30",
        filed_at: "2026-08-28",
        lag_days: 59,
        coverage_pct: 99,
        source_url: "",
        identified_pct: 99,
        coverage_by_cat: {},
        identified_by_cat: {},
      },
    ],
    oldest_as_of: "2026-06-30",
    max_lag_days: 59,
    unmapped: {
      positions: 0,
      positions_with_weight: 0,
      securities_with_weight: 0,
      securities_weight: 0,
      cash_and_derivatives_with_weight: 0,
      cash_and_derivatives_weight: 0,
      securities_by_country: {},
    },
    effective: { core: 3.2, broad: 4.1, singleStock: false },
  } as unknown as Ledger;
}

function modelOf(overrides: Partial<WorkspaceModel> = {}): WorkspaceModel {
  return {
    hasEntries: true,
    ledger: ledgerOf(99),
    funds: [VTI, VXUS],
    contested: {},
    portfolio: {
      entries: [
        { kind: "fund", key: "VTI", amount: 6_000 },
        { kind: "fund", key: "VXUS", amount: 4_000 },
      ],
      mode: "bp",
      total: 10_000,
    },
    split: {
      fundWeights: { VTI: 0.6, VXUS: 0.4 },
      direct: [],
      cash: 0,
      invested: 1,
      unallocated: 0,
    },
    ...overrides,
  } as unknown as WorkspaceModel;
}

describe("the metric strip", () => {
  it("has one metric per lens, in tab order", () => {
    const metrics = buildMetrics(modelOf(), "MSCI");
    expect(metrics.map((metric) => metric.id)).toEqual([
      "companies",
      "markets",
      "funds",
      "overlap",
      "quality",
    ]);
  });

  it("puts the company count and what the portfolio behaves like on Companies", () => {
    const companies = buildMetrics(modelOf(), "MSCI")[0];
    expect(companies?.value).toBe("4");
    expect(companies?.sub).toBe("behaves like 3.2");
    expect(companies?.sentence).toContain("Companies, 4, behaves like 3.2");
  });

  it("names all three tiers on Markets, and draws them as a bar", () => {
    const markets = buildMetrics(modelOf(), "MSCI")[1];
    // No headline number: the bar is the headline, and the three shares are the label.
    expect(markets?.value).toBeNull();
    // Switzerland is developed, so the 30% is DM and EM is zero.
    expect(markets?.sub).toBe("US 70.0% · DM 30.0% · EM 0.0%");
    // "DM", not "dev": the only abbreviation in the app that did not match its pair.
    expect(markets?.sub).not.toContain("dev");
    // Float sums: 0.4 + 0.2 + 0.1 is 0.7000000000000001, which is what the bar draws.
    expect(markets?.bar?.us).toBeCloseTo(0.7, 10);
    expect(markets?.bar?.dm).toBeCloseTo(0.3, 10);
    expect(markets?.bar?.em).toBe(0);
    // The compact form drops the decimal rather than letting an ellipsis hide a tier.
    expect(markets?.subCompact).toBe("US 70% · DM 30% · EM 0%");
    expect(markets?.sentence).toBe(
      "Markets: United States 70.0%, developed markets ex-US 30.0%, emerging markets 0.0%",
    );
    expect(markets?.tip).toBe(markets?.sentence);
  });

  it("shows the not-placed share only when it is worth a line", () => {
    // Every row in the default fixture is placed, so nothing is unplaced.
    expect(buildMetrics(modelOf(), "MSCI")[1]?.sub).not.toContain("not placed");

    // A tenth of the portfolio in cash is a tenth the three tiers cannot account for.
    const withCash = modelOf({ ledger: ledgerAt(0.9) });
    const markets = buildMetrics(withCash, "MSCI")[1];
    expect(markets?.sub).toContain("10.0% not placed");
    // The compact form rounds it with everything else.
    expect(markets?.subCompact).toContain("10% not placed");
  });

  it("puts the fund count and the effective number of funds on Funds", () => {
    const funds = buildMetrics(modelOf(), "MSCI")[2];
    expect(funds?.value).toBe("2");
    // 1 / (0.6² + 0.4²) = 1 / 0.52 = 1.923…, to one decimal.
    expect(funds?.sub).toBe("behaves like 1.9");
    // The largest fund's ticker is gone: it told a reader nothing they could act on.
    expect(funds?.sub).not.toContain("VTI");
  });

  it("names the stocks and cash the fund count leaves out", () => {
    const model = modelOf();
    const withExtras = {
      ...model,
      split: {
        fundWeights: { VTI: 0.6, VXUS: 0.4 },
        direct: [{ kind: "stock", key: "AMZN", weight: 0.1 }],
        cash: 0.03,
        invested: 0.97,
        unallocated: 0,
      },
    } as unknown as WorkspaceModel;
    const funds = buildMetrics(withExtras, "MSCI")[2];
    expect(funds?.sub).toBe("behaves like 1.9 · +1 stock · cash 3.0%");
    expect(funds?.sentence).toBe(
      "Funds, 2, behaves like 1.9 effective funds, plus 1 stock and 3.0% cash",
    );
  });

  it("puts the highest pairwise overlap and the pair on Overlap", () => {
    const overlap = buildMetrics(modelOf(), "MSCI")[3];
    expect(overlap?.value).toBe("20.0%");
    expect(overlap?.sub).toBe("VTI ↔ VXUS");
    expect(overlap?.sentence).toBe("Overlap, 20.0%, VTI ↔ VXUS");
  });

  it("puts coverage and the oldest period on Data quality", () => {
    const quality = buildMetrics(modelOf(), "MSCI")[4];
    expect(quality?.value).toBe("99.0%");
    expect(quality?.sub).toBe("oldest Jun 30, 2026");
  });
});

describe("the status dots", () => {
  it("carries the single-company risk band on Companies, in words too", () => {
    const companies = buildMetrics(modelOf(), "MSCI")[0];
    expect(companies?.dot?.band).toBe("very-concentrated");
    // The dot is never the only carrier: the band is in the accessible name.
    expect(companies?.sentence).toContain("Red · Very concentrated");
  });

  it("shows a Data quality dot only below the 70% band", () => {
    const above = buildMetrics(
      modelOf({ ledger: ledgerOf(COVERAGE_DOT_BELOW) }),
      "MSCI",
    )[4];
    expect(above?.dot).toBeNull();

    const below = buildMetrics(modelOf({ ledger: ledgerOf(69.9) }), "MSCI")[4];
    expect(below?.dot?.band).toBe("coverage");
    expect(below?.sentence).toContain("coverage below 70%");
  });

  it("puts no dot on Overlap, because the methodology sets no threshold", () => {
    // `web/app/methodology/page.tsx` defines what overlap is and sets no cut-off on it;
    // `OVERLAP_NOTABLE` in answer.ts is a "worth a sentence" line, not a judgement.
    expect(buildMetrics(modelOf(), "MSCI")[3]?.dot).toBeNull();
  });
});

describe("the states with nothing to count", () => {
  it("says there is no portfolio yet, and shows no number", () => {
    const metrics = buildMetrics(modelOf({ hasEntries: false, ledger: null }), "MSCI");
    for (const metric of metrics) {
      expect(metric.value).toBeNull();
      expect(metric.sentence).toContain("no portfolio yet");
    }
  });

  it("says the filings are being read, and still names the lens", () => {
    const metrics = buildMetrics(modelOf({ ledger: null }), "MSCI");
    for (const metric of metrics) {
      expect(metric.value).toBeNull();
      expect(metric.sentence).toContain("reading the filings");
    }
  });
});
