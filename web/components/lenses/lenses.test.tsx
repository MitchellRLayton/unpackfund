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
import { withEffective } from "../../lib/testing/ledger";

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

const LEDGERBase: Omit<Ledger, "effective"> = {
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
const LEDGER = withEffective(LEDGERBase);

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

/**
 * The Effective holdings pair on the Funds lens.
 *
 * Appended as its own block so nothing above it — which another agent is editing —
 * is touched. Imports the CSV builder and the frozen arithmetic where it needs them
 * rather than adding a line to the shared import header.
 *
 * Every value below is hand-computed from the fixture, not read back from the
 * function under test:
 *
 * - SPR holds 60% c1, 25% c2, 15% c3 of itself. Shares are already those numbers, so
 *   Core = 1/(0.36+0.0625+0.0225) = 1/0.445 = 2.247 → 2.2, and
 *   Broad = e^-(0.6·ln0.6 + 0.25·ln0.25 + 0.15·ln0.15) = e^0.9376 = 2.554 → 2.6.
 * - The AAA row of the shared fixture holds 50% c1 and 30% c2: shares 0.625 and
 *   0.375, so Core = 1/0.53125 = 1.882 → 1.9 and Broad = e^0.6616 = 1.938 → 1.9.
 * - The portfolio merges c1 across AAA and BBB, which is why its own pair (1.9 and
 *   2.3 from T = 0.70, shares 0.700/0.171/0.129) is neither the sum nor the average
 *   of the rows above it.
 */
describe("funds: the Effective holdings pair", () => {
  /** A fund that spreads itself over three companies, so Core and Broad differ. */
  const spread = fund({
    ticker: "SPR",
    coverage_pct: 100,
    holdings: [holding("c1", 6000), holding("c2", 2500), holding("c3", 1500)],
  });

  const spreadModel = {
    ...MODEL,
    funds: [spread],
    fundByTicker: new Map([[spread.ticker, spread]]),
    split: { ...MODEL.split, fundWeights: { [spread.ticker]: 0.9 } },
  } as WorkspaceModel;

  it("heads a two-column group and prints each fund's own pair", () => {
    const html = renderToStaticMarkup(<FundsLens model={spreadModel} />);
    expect(html).toContain("Effective holdings");
    expect(html).toContain('colSpan="2"');
    // The two words are glossary terms, so they are links here and popovers in a
    // browser; either way the label is the same word.
    expect(html).toMatch(/>Core</);
    expect(html).toMatch(/>Broad</);
    expect(html).toMatch(/>2\.2</);
    expect(html).toMatch(/>2\.6</);
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("ends with the portfolio's own pair and says it is not an average", () => {
    const html = renderToStaticMarkup(<FundsLens model={MODEL} />);
    expect(html).toContain("Your portfolio");
    expect(html).toContain(
      "Not an average of the rows above. Companies held by more than one fund merge, which lowers both counts.",
    );
    // The ledger's own pair, for a reader who never hovers: 1.9 and 2.3.
    expect(html).toMatch(/>1\.9</);
    expect(html).toMatch(/>2\.3</);
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("withholds both counts for a fund below the 60% floor, never a zero", () => {
    // 40% resolved to a company, 60% a security the release could not name.
    const thin = fund({
      ticker: BBB,
      coverage_pct: 40,
      holdings: [holding("c1", 4000), holding(null, 6000, "equity")],
    });
    const one = FUNDS[0];
    if (!one) throw new Error("fixture");
    const html = renderToStaticMarkup(
      <FundsLens model={model({ ledger: LEDGER, funds: [one, thin] })} />,
    );
    expect(html).toContain("40.0% not covered");
    // Both withheld cells are the table's no-number glyph, at the end of that row, and
    // nothing repeats the row's story: its own Coverage cell names the band and the
    // percentage already.
    const fromRow = html.slice(html.indexOf(">BBB<"));
    const thinRow = fromRow.slice(0, fromRow.indexOf("</tr>"));
    expect(thinRow).toContain('<td class="num">—</td><td class="num">—</td>');
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("writes core and broad as one-decimal columns, empty when withheld", async () => {
    const { fundsCsv } = await import("./lens-csv");
    const { effectiveHoldingsForFund } = await import("@/lib/effective-holdings");
    const pair = new Map([[spread.ticker, effectiveHoldingsForFund(spread)]]);
    const base = {
      name: spread.name,
      weight: 0.9,
      positions: 3,
      asOf: spread.as_of,
      filedAt: spread.filed_at,
      lagDays: spread.lag_days,
      top10Share: null,
      unmatchedWeight: 0,
      unmatchedPositions: 0,
    };

    const csv = fundsCsv(
      [
        { ...base, ticker: spread.ticker, coveragePct: 100 },
        { ...base, ticker: BBB, coveragePct: 40 },
      ],
      "2026-11-02.7",
      pair,
    );
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(
      "ticker,name,weight_pct,positions,coverage_pct,coverage_band,reporting_period,filed_at,age_days,top10_share_pct,core,broad,release_as_of",
    );
    expect(lines[1]).toBe(
      `SPR,SPR Fund,90.00,3,100.0,full,2026-06-30,2026-08-28,59,,2.2,2.6,2026-11-02.7`,
    );
    // A withheld pair is empty cells, not zeroes, and the row still travels.
    expect(lines[2]).toBe(
      `BBB,SPR Fund,90.00,3,40.0,none,2026-06-30,2026-08-28,59,,,,2026-11-02.7`,
    );
  });
});
