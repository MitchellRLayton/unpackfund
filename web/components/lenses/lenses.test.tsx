import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WorkspaceModel } from "@/lib/use-workspace";
import type {
  FundDocument,
  Holding,
  Ledger,
  LedgerRow,
  LedgerSource,
  ReleaseDescriptor,
  UnmappedBreakdown,
} from "@/lib/types";

import { FundsLens } from "./FundsLens";
import { MarketsLens } from "./MarketsLens";
import { OverlapLens } from "./OverlapLens";
import { QualityLens } from "./QualityLens";

/**
 * A render of each lens against a hand-worked portfolio — the same fixture the
 * arithmetic tests use, so a lens that prints a number also has a test that the
 * number is the right one.
 *
 * This is a smoke test with teeth: it catches a lens that throws, and it fails on
 * `NaN` or `undefined` reaching the page, which is how a missing division shows up.
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
const COUNTRIES: Record<string, string> = { c1: "US", c2: "IE" };

function row(input: {
  company_id: string;
  country: string | null;
  weight: number;
  sources: LedgerSource[];
}): LedgerRow {
  return {
    company_id: input.company_id,
    name: `Company ${input.company_id}`,
    ticker: input.company_id.toUpperCase(),
    country: input.country,
    weight: input.weight,
    benchmark_weight: null,
    holder_count: input.sources.filter((source) => source.kind === "fund").length,
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
};

const LEDGER: Ledger = {
  rows: ROWS,
  metrics: {
    hhi: 0.2626,
    effective_n: 3.8081,
    top10: 0.7,
    covered_weight_pct: (0.7 / 0.9) * 100,
    resolved_weight: 0.7,
    suppressed_weight: 0,
    invested_weight: 0.9,
    cash_weight: 0.1,
    unallocated_weight: 0,
  },
  benchmark: null,
  funds: FUNDS.map((document) => ({
    ticker: document.ticker,
    name: document.name,
    as_of: document.as_of,
    filed_at: document.filed_at,
    lag_days: document.lag_days,
    coverage_pct: document.coverage_pct,
    source_url: document.source_url,
  })),
  oldest_as_of: "2026-05-31",
  max_lag_days: 59,
  unmapped: UNMAPPED,
};

function model(input: { ledger: Ledger; funds: FundDocument[] }): WorkspaceModel {
  const docs = new Map(input.funds.map((document) => [document.ticker, document]));
  // Only the fields the lenses read are built; the rest belong to the shell and are
  // cast because a lens never touches them. A lens that starts reading one of them
  // fails this render instead of failing in the browser.
  return {
    ready: true,
    problem: null,
    release: { status: "ready", data: {} as ReleaseDescriptor },
    releaseAsOf: "2026-11-02.7",
    portfolio: {
      entries: [],
      mode: "percent",
      ready: true,
      problem: null,
      total: 10_000,
      complete: true,
      unallocatedBp: 0,
      overBp: 0,
    },
    split: {
      fundWeights: WEIGHTS,
      direct: [],
      cash: 0.1,
      invested: 0.9,
      unallocated: 0,
    },
    funds: input.funds,
    pendingFunds: [],
    fundsError: null,
    securities: { rows: new Map(), pending: [], error: null },
    countries: { ...COUNTRIES },
    benchmark: null,
    ledger: input.ledger,
    ledgerError: null,
    ledgerMode: "worker",
    durationMs: 12,
    hasHoldings: true,
    hasEntries: true,
    complete: true,
    lens: "markets",
    setLens: () => {},
    companyId: null,
    openCompany: () => {},
    fundByTicker: docs,
    countryOf: (companyId: string) => COUNTRIES[companyId] ?? null,
  } as unknown as WorkspaceModel;
}

const MODEL = model({ ledger: LEDGER, funds: FUNDS });

/** Every lens, rendered. A throw or a leaked `NaN` fails the suite. */
describe("the four lenses render a worked portfolio", () => {
  it("markets: one bar, two tables, the code in text and the tiers in words", () => {
    const html = renderToStaticMarkup(<MarketsLens model={MODEL} />);
    expect(html).toContain("United States");
    expect(html).toContain("Other developed markets");
    expect(html).toContain("49.00%");
    expect(html).toContain("Unplaced is 39.00%");
    expect(html).toContain("US");
    expect(html).toContain("Developed");
    expect(html).toContain("FTSE Russell");
    expect(html).toContain('data-tier="US"');
    expect(html).toContain('data-country-missing="true"');
    expect(html.match(/<table/g)).toHaveLength(2);
    expect(html).toContain("Export CSV");
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("funds: sortable headers with aria-sort on the header, and the three dates", () => {
    const html = renderToStaticMarkup(<FundsLens model={MODEL} />);
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain('aria-sort="none"');
    expect(html).toContain("Sorted by Weight, largest first");
    expect(html).toContain("2026-06-30 · filed 2026-08-28 · 59 days");
    expect(html).toContain("80.0% covered");
    expect(html).toContain("partial 60.0%");
    expect(html).toContain("45.71%");
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("overlap: a partial-band pair prints its number and says it is a floor", () => {
    const html = renderToStaticMarkup(<OverlapLens model={MODEL} />);
    expect(html).toContain("AAA and BBB hold 30.00% of their value");
    expect(html).toContain("30.00%");
    expect(html).toContain("BBB is 60.0% covered, so this overlap is a floor.");
    // The numbers stay in the table: the band qualifies a printed figure, it does
    // not replace one.
    expect(html).toContain("50.00%");
    expect(html).toContain("Companies in either");
    expect(html).not.toContain("not computed");
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("overlap: a fully covered pair prints plainly, with no note", () => {
    const covered = FUNDS.map((document) =>
      document.ticker === BBB ? { ...document, coverage_pct: 80 } : document,
    );
    const html = renderToStaticMarkup(
      <OverlapLens model={model({ ledger: LEDGER, funds: covered })} />,
    );
    expect(html).toContain("AAA and BBB hold 30.00% of their value");
    expect(html).not.toContain("so this overlap is a floor");
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("overlap: a fund below the floor withholds the pair and names the reason", () => {
    const withheld = FUNDS.map((document) =>
      document.ticker === BBB ? { ...document, coverage_pct: 41.2 } : document,
    );
    const html = renderToStaticMarkup(
      <OverlapLens model={model({ ledger: LEDGER, funds: withheld })} />,
    );
    expect(html).toContain("No pair of your funds can be compared");
    expect(html).toContain("not computed");
    expect(html).toContain("BBB is 41.2% covered, below the 60% floor.");
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("quality: bands, the cause split, the dates and the closing total", () => {
    const html = renderToStaticMarkup(<QualityLens model={MODEL} />);
    expect(html).toContain("77.8%");
    expect(html).toContain("80.0% covered");
    expect(html).toContain("partial 60.0%");
    expect(html).toContain("Share positions with no company");
    expect(html).toContain("Cash and derivative lines inside funds");
    expect(html).toContain("Filed weight outside the holding schedules");
    expect(html).toContain("100.00%");
    expect(html).toContain("In the partial band:");
    expect(html).toContain("2026-05-31");
    expect(html).toContain("59 days");
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("a cash-only mix gets its own sentence, not 'No portfolio yet'", () => {
    const cashOnly = {
      ...MODEL,
      hasHoldings: false,
      split: { fundWeights: {}, direct: [], cash: 1, invested: 0, unallocated: 0 },
    } as WorkspaceModel;
    const html = renderToStaticMarkup(<MarketsLens model={cashOnly} />);
    expect(html).toContain("Everything is in cash");
    expect(html).toContain("the coverage figures do not apply");
    expect(html).not.toContain("No portfolio yet");
    expect(html).not.toContain("<table");
  });

  it("an empty fragment still says there is no portfolio yet", () => {
    const empty = {
      ...MODEL,
      hasHoldings: false,
      hasEntries: false,
      split: { fundWeights: {}, direct: [], cash: 0, invested: 0, unallocated: 0 },
    } as WorkspaceModel;
    const html = renderToStaticMarkup(<QualityLens model={empty} />);
    expect(html).toContain("No portfolio yet");
    expect(html).not.toContain("Everything is in cash");
  });

  it("says what it is waiting for instead of printing a partial number", () => {
    const pending = {
      ...MODEL,
      pendingFunds: [BBB],
    } as WorkspaceModel;
    const html = renderToStaticMarkup(<FundsLens model={pending} />);
    expect(html).toContain("Waiting for filings");
    expect(html).toContain(BBB);
    expect(html).not.toContain("<table");

    const incomplete = {
      ...MODEL,
      complete: false,
      split: { ...MODEL.split, unallocated: 0.08 },
    } as WorkspaceModel;
    const incompleteHtml = renderToStaticMarkup(<QualityLens model={incomplete} />);
    expect(incompleteHtml).toContain("The portfolio is not whole yet");
    expect(incompleteHtml).toContain("8.00%");
    expect(incompleteHtml).not.toContain("<table");
  });
});
