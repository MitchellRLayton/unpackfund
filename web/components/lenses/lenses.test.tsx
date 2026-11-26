import { fireEvent, render, screen } from "@testing-library/react";
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

import { CompaniesLens } from "./CompaniesLens";
import { FundsLens } from "./FundsLens";
import { MarketsLens } from "./MarketsLens";
import { OverlapLens } from "./OverlapLens";
import { QualityLens } from "./QualityLens";
import { withEffective } from "../../lib/testing/ledger";
import { flagEmoji } from "@/lib/country-flag";

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
  securities_by_country: {},
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
  it("markets: one bar, two tables, the code in text and the tiers as codes", () => {
    const html = renderToStaticMarkup(<MarketsLens model={MODEL} />);
    // Three segments, in OD-04's compact labels, and no fourth. The long name is the
    // tip's accessible name rather than the visible label, so it is never lost — only
    // said once, behind the code.
    expect(html).toContain('<th scope="row">US</th>');
    expect(html).toContain('<th scope="row">DM</th>');
    expect(html).toContain('<th scope="row">EM</th>');
    expect(html).toContain('aria-label="About US"');
    expect(html).toContain('aria-label="About DM"');
    expect(html).toContain('aria-label="About EM"');
    expect(html).not.toContain("Other developed markets");
    expect(html).not.toContain("No market tier");
    expect(html).not.toContain("Unplaced");
    expect(html).toContain("49.00%");
    // What the bar does not draw is stated with its own number instead of drawn.
    expect(html).toContain("Not in the bar:");
    expect(html).toContain("US");
    // The convention is named once, beside the toggle, and never on a label.
    expect(html).toContain('data-convention="MSCI"');
    expect(html).not.toContain("(MSCI)");
    expect(html).toContain('data-tier="US"');
    // The bar's numbers and the countries behind it. This portfolio holds no country
    // the two conventions disagree about, so the disagreement table is a sentence.
    expect(html.match(/<table/g)).toHaveLength(2);
    expect(html).toContain("The two conventions agree for this portfolio");
    // The download is an icon now; its accessible name carries the words.
    expect(html).toContain("Download this table as CSV");
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("markets: every country code in the by-country table carries its flag", () => {
    const html = renderToStaticMarkup(<MarketsLens model={MODEL} />);
    // The flag is derived from the code and is decoration — `aria-hidden`, with the
    // code printed beside it — so the assertion is on the pair, not on the glyph
    // alone. A cell that prints the code without the flag is the regression this
    // catches: it shipped once, and the code alone reads as a bare abbreviation.
    expect(html).toContain(
      `<span class="country-tag"><span aria-hidden="true">${flagEmoji("US")}</span> US</span>`,
    );
    expect(html).toContain(
      `<span class="country-tag"><span aria-hidden="true">${flagEmoji("IE")}</span> IE</span>`,
    );
  });

  it("companies: the comparison headings and picker name the chosen benchmark", () => {
    // The same ledger with VOO's weights: the pair of headings, the caption and the
    // picker must all name VOO rather than the default, and exactly one option is on.
    const benchmarked = withEffective({
      ...LEDGERBase,
      rows: ROWS.map((row, index) => ({
        ...row,
        benchmark_weight: index === 0 ? 0.08 : null,
      })),
      benchmark: {
        ticker: "VOO",
        name: "Vanguard 500 Index Fund",
        as_of: "2026-06-30",
        filed_at: "2026-08-28",
        lag_days: 59,
        coverage_pct: 99.2,
        source_url: "https://www.sec.gov/x",
      },
    });
    const html = renderToStaticMarkup(
      <CompaniesLens model={model({ ledger: benchmarked, funds: FUNDS })} />,
    );
    expect(html).toContain("Change vs VOO");
    expect(html).not.toContain("Change vs VT");
    expect(html).toContain("Benchmark: VOO.");
    expect(html).toContain("Active share vs VOO");
    // The picker: one group, five options, exactly one pressed (VT is the stored default
    // in this render; the headings follow the loaded benchmark, which is VOO).
    expect(html.match(/data-benchmark-choice/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    for (const ticker of ["VT", "VTI", "VOO", "IDEV", "IEMG"]) {
      expect(html).toContain(`>${ticker}</button>`);
    }
  });

  it("companies: the country cell carries the flag and the market word", () => {
    const html = renderToStaticMarkup(<CompaniesLens model={MODEL} />);
    expect(html).toContain(
      `<span class="country-tag"><span aria-hidden="true">${flagEmoji("US")}</span> US</span>`,
    );
    // The market word is the second line of the same cell, and it is what makes the
    // column header "Country, market" true rather than aspirational.
    expect(html).toContain("Developed");
  });

  it("funds: sortable headers with aria-sort on the header, and the three dates", () => {
    const html = renderToStaticMarkup(<FundsLens model={MODEL} />);
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain('aria-sort="none"');
    expect(html).toContain("Sorted by Weight, largest first");
    // P-F-03: every column that needs explaining carries its own tip, named for its
    // header, and the column holding the three dates is named after them.
    for (const label of [
      "Weight",
      "Positions",
      "Coverage",
      "Holdings as of",
      "Your top ten",
      "Effective holdings",
    ]) {
      expect(html).toContain(`aria-label="About ${label}"`);
    }
    expect(html).not.toContain("Reporting period, filed");
    // P-F-06: the cell reads as a date, not as three ISO strings; the filed year is
    // dropped because it is the period's own year, and it is still filed-then-lag.
    expect(html).toContain("Jun 30, 2026 · filed Aug 28 · 59 days");
    expect(html).toContain("80.0% covered");
    expect(html).toContain("partial 60.0%");
    expect(html).toContain("45.71%");
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("overlap: a partial-band pair prints its number and says it is a minimum", () => {
    const html = renderToStaticMarkup(<OverlapLens model={MODEL} />);
    expect(html).toContain("AAA and BBB hold 30.00% of their value");
    expect(html).toContain("30.00%");
    expect(html).toContain("Minimum: BBB is partly traced.");
    // The numbers stay in the table: the band qualifies a printed figure, it does
    // not replace one.
    expect(html).toContain("50.00%");
    expect(html).toContain("Companies in either");
    expect(html).not.toContain("not computed");
    // The caption is still a real `<caption>` for a screen reader, hidden visually
    // only (H9), and each column's meaning is a keyboard-reachable tip.
    expect(html).toContain('class="visually-hidden"');
    expect(html).toContain("Every pair of your funds, sorted by overlap.");
    expect(html).toContain('aria-label="About Overlap"');
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("overlap: a fully covered pair prints plainly, with no note column", () => {
    const covered = FUNDS.map((document) =>
      document.ticker === BBB ? { ...document, coverage_pct: 80 } : document,
    );
    const html = renderToStaticMarkup(
      <OverlapLens model={model({ ledger: LEDGER, funds: covered })} />,
    );
    expect(html).toContain("AAA and BBB hold 30.00% of their value");
    expect(html).not.toContain("Minimum:");
    // Nothing to qualify means no column to qualify in, and no chip either: both funds
    // are in the full band.
    expect(html).not.toContain(">Note<");
    expect(html).not.toContain("covered</span>");
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
    expect(html).toContain("Not compared: BBB is under 60% traced.");
    // The percentage is still on screen: it is the chip in the fund's own cell, which
    // the withheld band keeps (P-O-05).
    expect(html).toContain("41.2% not covered");
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("quality: bands, the cause split, the dates and the closing total", () => {
    const html = renderToStaticMarkup(<QualityLens model={MODEL} />);
    expect(html).toContain("77.8%");
    expect(html).toContain("80.0% covered");
    expect(html).toContain("partial 60.0%");
    expect(html).toContain("Unmatched securities");
    expect(html).toContain("Cash and derivatives in funds");
    expect(html).toContain("Filing adjustment");
    expect(html).toContain("100.00%");
    // The date cells are P-F-06's format, and the footer states the oldest period and
    // the slowest filing in the same words.
    expect(html).toContain("May 31, 2026 · filed Jul 1 · 31 days");
    expect(html).toContain("oldest May 31, 2026 · slowest 59 days");
    // The per-band prose is gone; the notes strip and `/methodology/#coverage` carry it.
    expect(html).not.toContain("In the partial band");
    // Both captions survive as sr-only `<caption>`s (H9), and the band rule is the
    // coverage header's tip rather than a paragraph.
    // The table opens in the order the reader added the funds, and every column except
    // the dates sorts, so the caption says so rather than claiming a fixed order.
    expect(html).toContain("Opens in the order you added the funds");
    expect(html).toContain("every column");
    // The four sortable headers carry a button; the dates column does not.
    expect(html.match(/table__sort/g) ?? []).toHaveLength(4);
    expect(html).toContain("Every part of your portfolio, adding to 100%.");
    expect(html).toContain('aria-label="About Coverage"');
    // The Count header carries the zero-basis-point rule now (P-Q-05). A tip's text is
    // only in the DOM while it is open, so the trigger is what a static render proves.
    expect(html).toContain('aria-label="About Count"');
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("quality: a row that prints as zero is not printed", () => {
    // CN_ZERO_ROW: a fund-less portfolio holds no cash, and "Your cash 0.00% —" is a
    // line of noise in a table whose job is to reconcile. "Named companies" and "Total"
    // are never hidden this way.
    const noCash = model({
      ledger: withEffective({
        ...LEDGERBase,
        metrics: { ...LEDGERBase.metrics, cash_weight: 0 },
      }),
      funds: FUNDS,
    });
    const html = renderToStaticMarkup(<QualityLens model={noCash} />);
    expect(html).not.toContain("Your cash");
    expect(html).toContain("Named companies");
    expect(html).toContain("Total");
  });

  it("quality: the count tip carries the zero-basis-point rule, in both forms", () => {
    const mixed = model({
      ledger: withEffective({
        ...LEDGERBase,
        unmapped: { ...UNMAPPED, positions: 34, positions_with_weight: 17 },
      }),
      funds: FUNDS,
    });
    const first = render(<QualityLens model={mixed} />);
    fireEvent.click(screen.getByRole("button", { name: "About Count" }));
    expect(screen.getByRole("tooltip").textContent).toBe(
      "Positions that carry weight. 17 more round to zero and aren't counted.",
    );
    first.unmount();

    // With nothing rounding to zero there is no clause to print: the sentence is the
    // whole tip (P-Q-05's Z = 0 form).
    render(<QualityLens model={MODEL} />);
    fireEvent.click(screen.getByRole("button", { name: "About Count" }));
    expect(screen.getByRole("tooltip").textContent).toBe("Positions that carry weight.");
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
    // P-L-02: the title names the count and the body names the funds.
    expect(html).toContain("Reading 1 filing…");
    expect(html).toContain("Still loading:");
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
    // P-F-05: the sentence is the row header's tooltip now, so it is carried by a
    // control with a name a reader can reach — not by a paragraph under the table.
    expect(html).toContain("About Your portfolio");
    expect(html).not.toContain("funds-portfolio-hint");
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

describe("funds: the expense ratio each prospectus states (T-0052 phase 3)", () => {
  const feeRow = (total: number, extra: Record<string, unknown> = {}) => ({
    class_id: null,
    total,
    net: null,
    waiver: null,
    basis: "no-waiver-stated",
    prospectus_date: "2026-04-29",
    filed_at: "2026-04-30",
    form: "485BPOS",
    source_url: "https://www.sec.gov/Archives/edgar/data/1/x.htm",
    ...extra,
  });
  const [aaa, bbb] = FUNDS as [FundDocument, FundDocument];
  const withFees = (document: FundDocument, classes: Record<string, unknown>) =>
    ({ ...document, fees: { classes } }) as unknown as FundDocument;

  // AAA is entered as its class AAAX (0.53% gross, 0.28% net); BBB as itself (0.10%).
  const AAAX = feeRow(0.0053, { net: 0.0028, waiver: -0.0025, basis: "stated-net" });
  const feeModel = (
    docs: FundDocument[],
    entries = [{ kind: "fund", key: AAA, amount: 4000, cls: "AAAX" }],
  ) =>
    ({
      ...model({ ledger: LEDGER, funds: docs }),
      portfolio: { ...MODEL.portfolio, entries },
    }) as unknown as WorkspaceModel;
  const both = [
    withFees(aaa, { AAA: feeRow(0.0003), AAAX }),
    withFees(bbb, { BBB: feeRow(0.001) }),
  ];

  it("adds no column, and says nothing about fees, when the funds carry none", () => {
    const html = renderToStaticMarkup(<FundsLens model={MODEL} />);
    expect(html).not.toContain("Expense ratio");
    expect(html).not.toContain("avg fee");
    expect(html).not.toMatch(/not stated/);
  });

  it("prints the class the visitor entered, not the published ticker's fee", () => {
    const html = renderToStaticMarkup(<FundsLens model={feeModel(both)} />);
    expect(html).toContain("Expense ratio");
    const fromRow = html.slice(html.indexOf(">AAA<"));
    const aaaRow = fromRow.slice(0, fromRow.indexOf("</tr>"));
    // AAAX's 0.28% net with 0.53% before waivers — and not AAA's own 0.03%.
    expect(aaaRow).toContain("0.28%");
    expect(aaaRow).toContain("AAAX · net of fee waivers; 0.53% before waivers");
    expect(aaaRow).not.toContain("0.03%");
    const fromB = html.slice(html.indexOf(">BBB<"));
    expect(fromB.slice(0, fromB.indexOf("</tr>"))).toContain(
      "BBB · no fee waiver stated",
    );
  });

  it("says 'not stated' for a class the document has no row for, never a sibling's figure", () => {
    const html = renderToStaticMarkup(
      <FundsLens model={feeModel([withFees(aaa, { AAA: feeRow(0.0003) }), bbb])} />,
    );
    const fromRow = html.slice(html.indexOf(">AAA<"));
    const aaaRow = fromRow.slice(0, fromRow.indexOf("</tr>"));
    expect(aaaRow).toContain("AAAX · not stated");
    expect(aaaRow).not.toContain("0.03%");
  });

  it("has no sort control on the fee column, and no new sortable column", () => {
    const html = renderToStaticMarkup(<FundsLens model={feeModel(both)} />);
    // Six sortable columns before phase 3, six after: the fee is a fact, not an ordering.
    expect(html.match(/class="table__sort"/g)).toHaveLength(6);
    const header = html.slice(
      html.indexOf("Expense ratio") - 120,
      html.indexOf("Expense ratio") + 40,
    );
    expect(header).not.toContain("table__sort");
    expect(header).not.toContain("aria-sort");
  });

  it("closes with the weighted average over the funds whose fee is known, and says how much", () => {
    // AAA 0.4 at 0.28% (AAAX net), BBB 0.3 at 0.10%: (0.4·0.28 + 0.3·0.10) / 0.7 = 0.2029…% → 0.20%.
    // Fees are known for all 0.7 of the fund weight.
    const html = renderToStaticMarkup(<FundsLens model={feeModel(both)} />);
    const foot = html.slice(html.indexOf("<tfoot>"));
    expect(foot).toContain("0.20%");
    expect(foot).toContain("weighted average, fees known for 100.0% of fund weight");
    expect(html).not.toMatch(/cheapest|lowest|best fee|NaN|undefined/);
  });

  it("withholds the average, and says why, when fees are known for under 60% of fund weight", () => {
    // Only AAA states a fee: 0.4 of 0.7 = 57.1%.
    const html = renderToStaticMarkup(
      <FundsLens model={feeModel([both[0] as FundDocument, bbb])} />,
    );
    const foot = html.slice(html.indexOf("<tfoot>"));
    expect(foot).toContain(
      "weighted average withheld: fees known for 57.1% of fund weight",
    );
    expect(foot).not.toContain("0.28%");
  });

  it("writes the same three facts to the CSV, and nothing when the release has no fees", async () => {
    const { fundsCsv } = await import("./lens-csv");
    const { feeFigure } = await import("@/lib/fees");
    const rows = [
      {
        ticker: AAA,
        name: "AAA Fund",
        weight: 0.4,
        positions: 1,
        coveragePct: 99,
        asOf: "2026-06-30",
        filedAt: "2026-08-28",
        lagDays: 59,
        top10Share: null,
        unmatchedWeight: 0,
        unmatchedPositions: 0,
      },
    ] as unknown as Parameters<typeof fundsCsv>[0];
    const stated = fundsCsv(rows, "2026-11-02.7", undefined, () => ({
      classTicker: "AAAX",
      figure: feeFigure(both[0], "AAAX"),
    }));
    expect(stated.split("\n")[0]).toContain(
      "fee_class,expense_ratio_pct,expense_ratio_basis",
    );
    expect(stated.split("\n")[1]).toContain("AAAX,0.28,net of fee waivers");
    expect(fundsCsv(rows, "2026-11-02.7").split("\n")[0]).not.toContain("expense_ratio");
  });
});
