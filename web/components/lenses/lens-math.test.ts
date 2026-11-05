import { describe, expect, it } from "vitest";

import {
  csvLine,
  fundsCsv,
  lensCsvName,
  marketsCsv,
  overlapCsv,
  qualityCsv,
} from "./lens-csv";
import {
  filedOvershoot,
  fundMixRows,
  marketSplit,
  nextSort,
  pairwiseOverlap,
  pairVerdict,
  sortBy,
  top10Attribution,
  untracedTotals,
  type FundMixRow,
} from "./lens-math";
import type {
  FundDocument,
  Holding,
  LedgerMetrics,
  LedgerRow,
  LedgerSource,
  UnmappedBreakdown,
} from "@/lib/types";

/**
 * Hand-worked fixtures, per `lookthrough-math-and-qa` §8: a number the author cannot
 * check on paper only proves the implementation agrees with itself.
 *
 * The fixture is one whole portfolio, 100.00%:
 *
 * | where                    | weight |
 * |--------------------------|--------|
 * | fund AAA                 | 40.00% |
 * | fund BBB                 | 30.00% |
 * | company c1 held directly | 20.00% |
 * | cash you hold            | 10.00% |
 *
 * AAA files 100.00% of NAV: c1 50%, c2 30%, one debt position no identifier matched
 * 10%, cash 10%. Coverage 80% (the full band).
 * BBB files 100.00% of NAV: c1 30%, c4 30%, one equity position unmapped 20%, one
 * derivative 20%. Coverage 60% (the partial band).
 *
 * The ledger therefore has three company lines:
 *   c1 = 0.40·0.50 + 0.30·0.30 + 0.20 = 0.49 (country US)
 *   c2 = 0.40·0.30                 = 0.12 (country IE — developed)
 *   c4 = 0.30·0.30                 = 0.09 (no country answer)
 * resolved 0.70, unmatched securities 0.10, cash and derivatives 0.10, cash 0.10.
 * Every expected value below is derived from that column, not from a previous run.
 */

const AAA = "AAA";
const BBB = "BBB";

const holding = (
  company_id: string | null,
  weight_bp: number,
  asset_cat: Holding["asset_cat"] = "equity",
): Holding => ({
  company_id,
  name: company_id === null ? "Unresolved position" : `Company ${company_id}`,
  ticker: company_id,
  asset_cat,
  weight_bp,
});

function fund(input: {
  ticker: string;
  coverage_pct: number;
  holdings: Holding[];
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
    coverage_pct: input.coverage_pct,
    holdings: input.holdings,
    metrics: { hhi: 0, hhi_pct2: 0, effective_n: 0, top10_pct: 0 },
    warnings: [],
  };
}

const FUNDS: FundDocument[] = [
  fund({
    ticker: AAA,
    coverage_pct: 80,
    holdings: [
      holding("c1", 5000),
      holding("c2", 3000),
      holding(null, 1000, "debt"),
      holding(null, 1000, "cash"),
    ],
  }),
  fund({
    ticker: BBB,
    coverage_pct: 60,
    as_of: "2026-05-31",
    filed_at: "2026-07-01",
    lag_days: 31,
    holdings: [
      holding("c1", 3000),
      holding("c4", 3000),
      holding(null, 2000, "equity"),
      holding(null, 2000, "derivative"),
    ],
  }),
];

const WEIGHTS: Record<string, number> = { [AAA]: 0.4, [BBB]: 0.3 };

const COUNTRIES: Record<string, string | null> = { c1: "US", c2: "IE", c4: null };

function row(input: {
  company_id: string;
  country: string | null;
  weight: number;
  sources: LedgerSource[];
}): LedgerRow {
  const holders = input.sources.filter((source) => source.kind === "fund").length;
  return {
    company_id: input.company_id,
    name: `Company ${input.company_id}`,
    ticker: input.company_id.toUpperCase(),
    country: input.country,
    weight: input.weight,
    benchmark_weight: null,
    holder_count: holders,
    held_directly: input.sources.some((source) => source.kind === "security"),
    sources: input.sources,
  };
}

const ROWS: LedgerRow[] = [
  row({
    company_id: "c1",
    country: "US",
    weight: 0.49,
    sources: [
      { kind: "fund", ref: AAA, weight: 0.2 },
      { kind: "fund", ref: BBB, weight: 0.09 },
      { kind: "security", ref: "c1", weight: 0.2 },
    ],
  }),
  row({
    company_id: "c2",
    country: "IE",
    weight: 0.12,
    sources: [{ kind: "fund", ref: AAA, weight: 0.12 }],
  }),
  row({
    company_id: "c4",
    country: null,
    weight: 0.09,
    sources: [{ kind: "fund", ref: BBB, weight: 0.09 }],
  }),
];

const UNMAPPED: UnmappedBreakdown = {
  positions: 4,
  positions_with_weight: 4,
  securities_with_weight: 2,
  securities_weight: 0.1,
  cash_and_derivatives_with_weight: 2,
  cash_and_derivatives_weight: 0.1,
  // The two unmatched share positions, by the country their own filing states for
  // them: 0.06 in Japan (developed) and 0.04 with no country stated.
  securities_by_country: { JP: 0.06, "": 0.04 },
};

const METRICS: LedgerMetrics = {
  hhi: 0.2626,
  effective_n: 3.8081,
  top10: 0.7,
  covered_weight_pct: (0.7 / 0.9) * 100,
  resolved_weight: 0.7,
  suppressed_weight: 0,
  invested_weight: 0.9,
  cash_weight: 0.1,
  unallocated_weight: 0,
};

const countryOf =
  (map: Record<string, string | null>) =>
  (companyId: string): string | null =>
    map[companyId] ?? null;

describe("marketSplit", () => {
  const split = marketSplit({
    rows: ROWS,
    countryOf: countryOf(COUNTRIES),
    contested: {},
    unmapped: UNMAPPED,
    metrics: METRICS,
    funds: FUNDS,
    weights: WEIGHTS,
  });

  const bucket = (id: string) => {
    const found = split.tiers.find((tier) => tier.bucket === id);
    if (!found) throw new Error(`no bucket ${id}`);
    return found;
  };

  it("draws exactly three segments, in the order the bar draws them", () => {
    expect(split.tiers.map((tier) => tier.bucket)).toEqual(["US", "DM", "EM"]);
  });

  it("places each company line in its market tier", () => {
    expect(bucket("US").weight).toBeCloseTo(0.49, 10);
    expect(bucket("US").companies).toBe(1);
    // 0.12 of Irish companies, plus the 0.06 of unmatched positions filed as Japanese.
    expect(bucket("DM").weight).toBeCloseTo(0.18, 10);
    expect(bucket("EM").weight).toBeCloseTo(0, 10);
    expect(split.resolved).toBeCloseTo(0.7, 10);
    expect(split.companies).toBe(3);
    expect(split.hasNegative).toBe(false);
  });

  it("places an unmatched share position by the country its filing states", () => {
    // 0.12 of Irish companies + 0.06 of Japanese positions = 0.18 in developed.
    expect(bucket("DM").weight).toBeCloseTo(0.18, 10);
    // The bar's denominator is the weight the release can place, not the portfolio.
    expect(split.placed).toBeCloseTo(0.49 + 0.18, 10);
  });

  it("keeps one row per country, largest first", () => {
    expect(split.countries.map((country) => country.code)).toEqual(["US", "IE", "JP"]);
    expect(split.countries[0]?.weight).toBeCloseTo(0.49, 10);
    expect(split.countries[1]?.tier).toBe("DM");
    // A country carried only by unmatched positions has weight but no company line.
    expect(split.countries[2]?.companies).toBe(0);
  });

  it("states what the bar does not draw, and closes the portfolio", () => {
    expect(split.outside.unplacedCompanies).toBe(1);
    expect(split.outside.unplacedCompanyWeight).toBeCloseTo(0.09, 10);
    // The 0.04 of unmatched positions whose filing states no country.
    expect(split.outside.unplacedSecurities).toBeCloseTo(0.04, 10);
    expect(split.outside.cashAndDerivatives).toBeCloseTo(0.1, 10);
    expect(split.outside.cash).toBeCloseTo(0.1, 10);
    expect(split.outside.filedOvershoot).toBeCloseTo(0, 10);
    // 0.09 + 0.04 + 0.10 + 0.10 − 0 = 0.33
    expect(split.outside.total).toBeCloseTo(0.33, 10);
    expect(split.placed + split.outside.total).toBeCloseTo(1, 10);
  });

  it("places a company the vote could not decide from the contested map", () => {
    const withContested = marketSplit({
      rows: ROWS,
      countryOf: countryOf(COUNTRIES),
      contested: { c4: "KY" },
      unmapped: UNMAPPED,
      metrics: METRICS,
      funds: FUNDS,
      weights: WEIGHTS,
    });
    // KY is an offshore holding domicile: the United States, not a fourth bucket.
    const us = withContested.tiers.find((tier) => tier.bucket === "US");
    expect(us?.weight).toBeCloseTo(0.49 + 0.09, 10);
    expect(withContested.outside.unplacedCompanies).toBe(0);
    expect(withContested.outside.unplacedCompanyWeight).toBeCloseTo(0, 10);
  });

  it("falls back to the row's own country when the release has no map", () => {
    const noMap = marketSplit({
      rows: ROWS,
      countryOf: countryOf({}),
      contested: {},
      unmapped: UNMAPPED,
      metrics: METRICS,
      funds: FUNDS,
      weights: WEIGHTS,
    });
    const us = noMap.tiers.find((tier) => tier.bucket === "US");
    expect(us?.weight).toBeCloseTo(0.49, 10);
    expect(noMap.outside.unplacedCompanies).toBe(1);
  });
});

describe("pairwiseOverlap", () => {
  it("computes Σ min of the two funds' own weights, from the ledger's sources", () => {
    const pairs = pairwiseOverlap({
      rows: ROWS,
      weights: WEIGHTS,
      tickers: [AAA, BBB],
    });
    expect(pairs).toHaveLength(1);
    const pair = pairs[0];
    if (!pair) throw new Error("no pair");

    // AAA's own weights: c1 0.20/0.40 = 0.50, c2 0.12/0.40 = 0.30.
    // BBB's own weights: c1 0.09/0.30 = 0.30, c4 0.09/0.30 = 0.30.
    // overlap = min(0.50, 0.30) = 0.30; onlyA = 0.20 + 0.30 = 0.50;
    // onlyB = 0.30.
    expect(pair.overlap).toBeCloseTo(0.3, 10);
    expect(pair.onlyA).toBeCloseTo(0.5, 10);
    expect(pair.onlyB).toBeCloseTo(0.3, 10);
    expect(pair.sharedCompanies).toBe(1);
    expect(pair.unionCompanies).toBe(3);
    expect(pair.resolvedA).toBeCloseTo(0.8, 10);
    expect(pair.resolvedB).toBeCloseTo(0.6, 10);
    expect(pair.weightA).toBeCloseTo(0.4, 10);
    expect(pair.weightB).toBeCloseTo(0.3, 10);

    // The identity the caption states: overlap + only = what resolved.
    expect(pair.overlap + pair.onlyA).toBeCloseTo(pair.resolvedA, 10);
    expect(pair.overlap + pair.onlyB).toBeCloseTo(pair.resolvedB, 10);
  });

  it("is symmetric in the pair's arguments", () => {
    const pairs = pairwiseOverlap({
      rows: ROWS,
      weights: WEIGHTS,
      tickers: [BBB, AAA],
    });
    const pair = pairs[0];
    if (!pair) throw new Error("no pair");
    expect(pair.a).toBe(BBB);
    expect(pair.b).toBe(AAA);
    expect(pair.overlap).toBeCloseTo(0.3, 10);
    expect(pair.onlyA).toBeCloseTo(0.3, 10);
    expect(pair.onlyB).toBeCloseTo(0.5, 10);
  });

  it("has no pair for a fund with no weight, and ignores a negative source", () => {
    const pairs = pairwiseOverlap({
      rows: [
        ...ROWS,
        row({
          company_id: "c9",
          country: "US",
          weight: 0.01,
          sources: [
            { kind: "fund", ref: BBB, weight: -0.01 },
            { kind: "fund", ref: "CCC", weight: 0.02 },
          ],
        }),
      ],
      weights: { [AAA]: 0.4, [BBB]: 0.3, CCC: 0 },
      tickers: [AAA, BBB, "CCC"],
    });
    expect(pairs).toHaveLength(1);
    const pair = pairs[0];
    if (!pair) throw new Error("no pair");
    expect(pair.overlap).toBeCloseTo(0.3, 10);
    expect(pair.resolvedB).toBeCloseTo(0.6, 10);
  });
});

describe("pairVerdict", () => {
  const fund = (ticker: string, coveragePct: number | null) => ({ ticker, coveragePct });

  it("prints a pair plainly when both funds are in the full band", () => {
    expect(pairVerdict(fund(AAA, 80), fund(BBB, 91.5))).toEqual({
      state: "printed",
      note: null,
    });
    // The band boundary is 70.0 exactly, and it is inclusive.
    expect(pairVerdict(fund(AAA, 70), fund(BBB, 100)).state).toBe("printed");
  });

  it("prints a partial-band pair and says in words that it is a floor", () => {
    const verdict = pairVerdict(fund(AAA, 80), fund(BBB, 64.8));
    expect(verdict.state).toBe("floor");
    expect(verdict.note).toBe("BBB is 64.8% covered, so this overlap is a floor.");
    // 60.0 is partial, not full.
    expect(pairVerdict(fund(AAA, 60), fund(BBB, 100)).state).toBe("floor");
  });

  it("names every partial fund when both are in that band", () => {
    expect(pairVerdict(fund(AAA, 68), fund(BBB, 61)).note).toBe(
      "AAA is 68.0% covered and BBB is 61.0% covered, so this overlap is a floor.",
    );
  });

  it("withholds the pair below the 60% floor, naming the fund and its percentage", () => {
    const verdict = pairVerdict(fund(AAA, 80), fund(BBB, 59.9));
    expect(verdict.state).toBe("withheld");
    expect(verdict.note).toBe("BBB is 59.9% covered, below the 60% floor.");
    // A withheld fund settles it even when the other one is in the full band.
    expect(pairVerdict(fund(AAA, 100), fund(BBB, 0)).state).toBe("withheld");
  });

  it("keeps the strongest reason when both funds are below the floor", () => {
    expect(pairVerdict(fund(AAA, 37), fund(BBB, 12)).note).toBe(
      "AAA is 37.0% covered and BBB is 12.0% covered, below the 60% floor.",
    );
  });

  it("withholds a pair with no coverage figure at all", () => {
    const verdict = pairVerdict(fund(AAA, null), fund(BBB, 80));
    expect(verdict.state).toBe("withheld");
    expect(verdict.note).toBe(
      "AAA has no coverage figure, so this pair cannot be compared.",
    );
  });
});

describe("top10Attribution", () => {
  const top10 = top10Attribution(ROWS);

  it("takes the positive rows largest first, ties by company id", () => {
    expect(top10.rows.map((entry) => entry.company_id)).toEqual(["c1", "c2", "c4"]);
    expect(top10.total).toBeCloseTo(0.7, 10);
  });

  it("attributes each part to the fund or the direct position it came through", () => {
    expect(top10.byFund.get(AAA)).toBeCloseTo(0.32, 10);
    expect(top10.byFund.get(BBB)).toBeCloseTo(0.18, 10);
    expect(top10.direct).toBeCloseTo(0.2, 10);
    expect(
      (top10.byFund.get(AAA) ?? 0) + (top10.byFund.get(BBB) ?? 0) + top10.direct,
    ).toBeCloseTo(top10.total, 10);
  });

  it("honours a smaller count", () => {
    const two = top10Attribution(ROWS, 2);
    expect(two.rows.map((entry) => entry.company_id)).toEqual(["c1", "c2"]);
    expect(two.total).toBeCloseTo(0.61, 10);
  });
});

describe("fundMixRows", () => {
  const top10 = top10Attribution(ROWS);
  const rows = fundMixRows({
    tickers: [AAA, BBB],
    weights: WEIGHTS,
    docs: new Map(FUNDS.map((document) => [document.ticker, document])),
    top10,
  });

  const find = (ticker: string): FundMixRow => {
    const found = rows.find((entry) => entry.ticker === ticker);
    if (!found) throw new Error(`no row ${ticker}`);
    return found;
  };

  it("carries the weight, the filing's line count and the three dates", () => {
    expect(find(AAA).weight).toBeCloseTo(0.4, 10);
    expect(find(AAA).positions).toBe(4);
    expect(find(AAA).coveragePct).toBe(80);
    expect(find(AAA).asOf).toBe("2026-06-30");
    expect(find(AAA).filedAt).toBe("2026-08-28");
    expect(find(AAA).lagDays).toBe(59);
  });

  it("computes each fund's share of the ten largest, and the rest is direct", () => {
    // 0.32 / 0.70 and 0.18 / 0.70.
    expect(find(AAA).top10Share).toBeCloseTo(0.32 / 0.7, 10);
    expect(find(BBB).top10Share).toBeCloseTo(0.18 / 0.7, 10);
    expect((find(AAA).top10Share ?? 0) + (find(BBB).top10Share ?? 0)).toBeCloseTo(
      1 - 0.2 / 0.7,
      10,
    );
  });

  it("weights the fund's positions with no company into the portfolio", () => {
    // AAA: debt 1000bp + cash 1000bp of its own 100.00% → 20% of 40.00% = 8.00%.
    // BBB: equity 2000bp + derivative 2000bp → 40% of 30.00% = 12.00%.
    expect(find(AAA).unmatchedWeight).toBeCloseTo(0.08, 10);
    expect(find(BBB).unmatchedWeight).toBeCloseTo(0.12, 10);
    expect(find(AAA).unmatchedPositions).toBe(2);
    const total = rows.reduce((sum, entry) => sum + (entry.unmatchedWeight ?? 0), 0);
    expect(total).toBeCloseTo(
      UNMAPPED.securities_weight + UNMAPPED.cash_and_derivatives_weight,
      10,
    );
  });
});

describe("untracedTotals and filedOvershoot", () => {
  it("closes the portfolio to 100%", () => {
    const totals = untracedTotals({
      metrics: METRICS,
      unmapped: UNMAPPED,
      funds: FUNDS,
      weights: WEIGHTS,
    });
    expect(totals.resolved).toBeCloseTo(0.7, 10);
    expect(totals.unmatchedSecurities).toBeCloseTo(0.1, 10);
    expect(totals.unmatchedCashDerivatives).toBeCloseTo(0.1, 10);
    expect(totals.cash).toBeCloseTo(0.1, 10);
    expect(totals.unallocated).toBeCloseTo(0, 10);
    expect(totals.filedOvershoot).toBeCloseTo(0, 10);
    expect(totals.total).toBeCloseTo(1, 10);
  });

  it("keeps the signed correction when a fund files more or less than 100%", () => {
    const over = fund({
      ticker: "OVER",
      coverage_pct: 90,
      holdings: [holding("c1", 10100)],
    });
    const under = fund({
      ticker: "UNDER",
      coverage_pct: 90,
      holdings: [holding("c1", 9900)],
    });
    // 0.30 · (101.00% − 100%) = +0.003; 0.20 · (99.00% − 100%) = −0.002.
    expect(filedOvershoot([over], { OVER: 0.3 })).toBeCloseTo(0.003, 12);
    expect(filedOvershoot([under], { UNDER: 0.2 })).toBeCloseTo(-0.002, 12);
    expect(filedOvershoot([over, under], { OVER: 0.3, UNDER: 0.2 })).toBeCloseTo(
      0.001,
      12,
    );
    // A fund with no weight contributes nothing to the correction.
    expect(filedOvershoot([over], { OVER: 0 })).toBeCloseTo(0, 12);
  });
});

describe("sorting", () => {
  const rows: FundMixRow[] = [
    {
      ticker: "B",
      name: null,
      weight: 0.2,
      positions: 3,
      coveragePct: 80,
      asOf: "2026-01-01",
      filedAt: "2026-02-01",
      lagDays: 31,
      top10Share: 0.1,
      unmatchedWeight: 0.01,
      unmatchedPositions: 1,
    },
    {
      ticker: "A",
      name: null,
      weight: 0.5,
      positions: 9,
      coveragePct: 65,
      asOf: "2026-06-30",
      filedAt: "2026-08-28",
      lagDays: 59,
      top10Share: 0.4,
      unmatchedWeight: 0.05,
      unmatchedPositions: 2,
    },
  ];

  it("flips a column and starts a new column in its own direction", () => {
    const first = nextSort(
      { key: "weight" as const, direction: "descending" as const },
      "weight",
      "descending",
    );
    expect(first).toEqual({ key: "weight", direction: "ascending" });
    const other = nextSort(first, "ticker", "ascending");
    expect(other).toEqual({ key: "ticker", direction: "ascending" });
  });

  it("sorts a copy and never the input", () => {
    const compare = {
      ticker: (a: FundMixRow, b: FundMixRow) => a.ticker.localeCompare(b.ticker),
      weight: (a: FundMixRow, b: FundMixRow) => a.weight - b.weight,
    };

    expect(
      sortBy(rows, { key: "weight", direction: "descending" }, compare).map(
        (entry) => entry.ticker,
      ),
    ).toEqual(["A", "B"]);
    expect(
      sortBy(rows, { key: "ticker", direction: "ascending" }, compare).map(
        (entry) => entry.ticker,
      ),
    ).toEqual(["A", "B"]);
    expect(
      sortBy(rows, { key: "ticker", direction: "descending" }, compare).map(
        (entry) => entry.ticker,
      ),
    ).toEqual(["B", "A"]);
    expect(rows.map((entry) => entry.ticker)).toEqual(["B", "A"]);
  });
});

describe("CSV", () => {
  const split = marketSplit({
    rows: ROWS,
    countryOf: countryOf(COUNTRIES),
    contested: {},
    unmapped: UNMAPPED,
    metrics: METRICS,
    funds: FUNDS,
    weights: WEIGHTS,
  });
  const releaseAsOf = "2026-11-02.7";

  it("quotes a cell that holds a comma, a quote or a newline", () => {
    expect(csvLine(["plain", "has,comma", 'has"quote', "line\nbreak"])).toBe(
      'plain,"has,comma","has""quote","line\nbreak"',
    );
    expect(csvLine([null, undefined, 0])).toBe(",,0");
  });

  it("names the file after the kind, the day and the release", () => {
    expect(lensCsvName("markets", new Date("2026-11-03T12:00:00Z"), releaseAsOf)).toBe(
      "unpackfund-markets-2026-11-03-2026-11-02.7.csv",
    );
    expect(lensCsvName("funds", new Date("2026-11-03T12:00:00Z"), "2026/11/02")).toBe(
      "unpackfund-funds-2026-11-03-2026_11_02.csv",
    );
  });

  it("writes the three market segments, what is outside the bar, and every country", () => {
    const csv = marketsCsv(split, releaseAsOf);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(
      "section,bucket,country_code,market,tier,weight_pct,companies,release_as_of",
    );
    expect(csv).toContain(`market,US,,United States,US,49.00,1,${releaseAsOf}`);
    expect(csv).toContain(
      `market,DM,,International Developed ex-US,Developed,18.00,1,${releaseAsOf}`,
    );
    expect(csv).toContain(`market,EM,,Emerging Markets,Emerging,0.00,0,${releaseAsOf}`);
    // No fourth market row: what the bar does not draw is a property of the whole
    // portfolio, written as its own section.
    expect(csv).not.toContain("UNPLACED");
    expect(csv).toContain(`outside,TOTAL,,Outside the bar,,33.00,1,${releaseAsOf}`);
    expect(csv).toContain(`country,US,US,,US,49.00,1,${releaseAsOf}`);
    expect(csv).toContain(`country,DM,JP,,Developed,6.00,0,${releaseAsOf}`);
    expect(csv.endsWith("\n")).toBe(true);
  });

  it("writes one row per fund, with the band and the three dates", () => {
    const csv = fundsCsv(
      [
        {
          ticker: AAA,
          name: "AAA Fund, Institutional",
          weight: 0.4,
          positions: 4,
          coveragePct: 80,
          asOf: "2026-06-30",
          filedAt: "2026-08-28",
          lagDays: 59,
          top10Share: 0.32 / 0.7,
          unmatchedWeight: 0.04,
          unmatchedPositions: 2,
        },
      ],
      releaseAsOf,
    );
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(
      "ticker,name,weight_pct,positions,coverage_pct,coverage_band,reporting_period,filed_at,age_days,top10_share_pct,release_as_of",
    );
    expect(lines[1]).toBe(
      `AAA,"AAA Fund, Institutional",40.00,4,80.0,full,2026-06-30,2026-08-28,59,45.71,${releaseAsOf}`,
    );
  });

  it("leaves the numbers empty rather than zero when a pair is withheld", () => {
    const floor = pairVerdict(
      { ticker: AAA, coveragePct: 80 },
      { ticker: BBB, coveragePct: 60 },
    );
    const withheld = pairVerdict(
      { ticker: "CCC", coveragePct: 40 },
      { ticker: "DDD", coveragePct: 90 },
    );
    const csv = overlapCsv(
      [
        {
          a: AAA,
          b: BBB,
          overlap: 0.3,
          onlyA: 0.5,
          onlyB: 0.3,
          sharedCompanies: 1,
          unionCompanies: 3,
          coverageAPct: 80,
          coverageBPct: 60,
          state: floor.state,
          note: floor.note,
        },
        {
          a: "CCC",
          b: "DDD",
          overlap: null,
          onlyA: null,
          onlyB: null,
          sharedCompanies: null,
          unionCompanies: null,
          coverageAPct: 40,
          coverageBPct: 90,
          state: withheld.state,
          note: withheld.note,
        },
      ],
      releaseAsOf,
    );
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(
      "fund_a,fund_b,overlap_pct,only_a_pct,only_b_pct,shared_companies,union_companies,coverage_a_pct,coverage_b_pct,state,note,release_as_of",
    );
    // The qualifier travels with the numbers: a file quieter than the page would be a
    // second, more confident answer. The expected line is built with the same
    // quoting rule, which is tested on its own above.
    expect(lines[1]).toBe(
      csvLine([
        AAA,
        BBB,
        "30.00",
        "50.00",
        "30.00",
        1,
        3,
        "80.0",
        "60.0",
        "floor",
        floor.note,
        releaseAsOf,
      ]),
    );
    // A withheld pair keeps its row, with the numbers empty rather than zero.
    expect(lines[2]).toBe(
      csvLine([
        "CCC",
        "DDD",
        "",
        "",
        "",
        "",
        "",
        "40.0",
        "90.0",
        "withheld",
        withheld.note,
        releaseAsOf,
      ]),
    );
  });

  it("writes the quality sections, including the correction that closes the total", () => {
    const totals = untracedTotals({
      metrics: METRICS,
      unmapped: UNMAPPED,
      funds: FUNDS,
      weights: WEIGHTS,
    });
    const csv = qualityCsv({
      funds: [
        {
          ticker: AAA,
          weight: 0.4,
          noCompany: 0.04,
          coveragePct: 80,
          asOf: "2026-06-30",
          filedAt: "2026-08-28",
          lagDays: 59,
        },
      ],
      invested: METRICS.invested_weight,
      coveragePct: METRICS.covered_weight_pct,
      totals,
      unmapped: UNMAPPED,
      releaseAsOf,
    });
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(
      "section,item,weight_pct,no_company_pct,coverage_pct,count,reporting_period,filed_at,age_days,note,release_as_of",
    );
    expect(csv).toContain(
      `coverage,AAA,40.00,4.00,80.0,,2026-06-30,2026-08-28,59,full,${releaseAsOf}`,
    );
    expect(csv).toContain(`untraced,total,100.00,,`);
    expect(csv).toContain("untraced,filed weight outside the holding schedules,0.00,");
  });
});
