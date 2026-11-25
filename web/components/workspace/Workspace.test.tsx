import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildLedger } from "@/lib/aggregate";
import { flagEmoji } from "@/lib/country-flag";
import { benchmarkFor } from "@/lib/benchmark";
import { CASH_KEY } from "@/lib/holdings";
import { splitPortfolio } from "@/lib/portfolio-weights";
import type {
  FundDocument,
  Ledger,
  PortfolioEntry,
  ReleaseDescriptor,
} from "@/lib/types";
import type { WorkspaceModel } from "@/lib/use-workspace";
import type { Lens } from "@/lib/view-fragment";

import { Workspace } from "./Workspace";
import { EXAMPLE_TICKERS } from "./example";

/**
 * The workspace shell, driven through a hand-built model.
 *
 * `useWorkspace` is the one thing mocked: everything below it — the answer builder, the
 * gate, the lenses, the tables, the tab pattern — runs for real against a ledger that
 * `buildLedger` produced from three small filings. That is the boundary worth testing,
 * because the shell's job is to arrange real components and hand them the model; a mocked
 * shell would only prove that the mocks agree with each other.
 *
 * What is pinned: the answer's sentences, the companies table's shape (the tier edge, the
 * country answer, the row's open control, the funds named on the row), the benchmark
 * columns and their absence, sorting, filtering, paging, the tabs writing to the model, and
 * the honesty states — no portfolio, an incomplete one, and one whose filings have not
 * arrived.
 */

const { state, saved } = vi.hoisted(() => ({
  state: { model: null as unknown as WorkspaceModel },
  /** CSV text handed to `saveCsv`, so a test can count its lines. */
  saved: [] as string[],
}));

vi.mock("@/lib/use-workspace", () => ({
  useWorkspace: () => state.model,
}));

vi.mock("@/lib/export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/export")>();
  return {
    ...actual,
    saveCsv: (text: string) => {
      saved.push(text);
    },
  };
});

vi.mock("@/lib/use-release", () => ({
  // The release publishes the example's seven tickers as well as the three fixture funds,
  // because the worked example on the empty state fetches exactly those seven.
  useTickers: () => ({
    status: "ready",
    data: [...EXAMPLE_TICKERS, "VTI", "VXUS", "BND"],
    error: null,
  }),
  useCatalogue: () => ({ status: "idle", data: null, error: null }),
  useFunds: () => ({ funds: EXAMPLE_FUNDS, pending: [], error: null }),
  useBenchmark: () => ({ status: "idle", data: null, error: null }),
  useCountries: () => ({
    status: "ready",
    data: { companies: COUNTRIES, contested: {} },
    error: null,
  }),
}));

const RELEASE = { as_of: "2026-10-30.8" } as unknown as ReleaseDescriptor;

function fund(
  ticker: string,
  coveragePct: number,
  holdings: [string | null, number][],
): FundDocument {
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
    coverage_pct: coveragePct,
    holdings: holdings.map(([companyId, weightBp]) => ({
      company_id: companyId,
      name: companyId === null ? "Unidentified position" : `Company ${companyId}`,
      ticker: null,
      asset_cat: "equity" as const,
      weight_bp: weightBp,
    })),
    metrics: { hhi: 0, hhi_pct2: 0, effective_n: 0, top10_pct: 0 },
    warnings: [],
  };
}

const COUNTRIES: Record<string, string> = {
  c_apple: "US",
  c_msft: "US",
  c_nvda: "US",
  c_treasury: "US",
  c_nestle: "CH",
  c_tsmc: "TW",
  c_samsung: "KR",
};

// `c_nowhere` is deliberately absent from COUNTRIES: a company the release cannot place
// is a row this table has to keep, with a dashed edge and no claim about its market.
const VTI = fund("VTI", 100, [
  ["c_apple", 3_500],
  ["c_msft", 3_000],
  ["c_nvda", 3_000],
  ["c_nowhere", 500],
]);
const VXUS = fund("VXUS", 100, [
  ["c_nestle", 5_000],
  ["c_tsmc", 3_000],
  ["c_samsung", 2_000],
]);
const BND = fund("BND", 100, [["c_treasury", 10_000]]);

const FUNDS = [VTI, VXUS, BND];

/**
 * The worked example's seven filings, so the empty state's example reaches "ready".
 *
 * Each fund holds two of the fixture companies and they overlap heavily — the example
 * exists to make that overlap visible, and the shell only needs filings that add up, not
 * the funds' real portfolios.
 */
const EXAMPLE_FUNDS = [
  fund("QQQ", 100, [
    ["c_apple", 5_000],
    ["c_msft", 5_000],
  ]),
  fund("VOO", 100, [
    ["c_apple", 6_000],
    ["c_nvda", 4_000],
  ]),
  fund("SMH", 100, [
    ["c_nvda", 8_000],
    ["c_tsmc", 2_000],
  ]),
  fund("VGT", 100, [
    ["c_msft", 6_000],
    ["c_apple", 4_000],
  ]),
  fund("RSPT", 100, [
    ["c_nvda", 5_000],
    ["c_nestle", 5_000],
  ]),
  fund("ARKK", 100, [
    ["c_tsmc", 5_000],
    ["c_samsung", 5_000],
  ]),
  fund("ALAI", 100, [
    ["c_samsung", 4_000],
    ["c_msft", 6_000],
  ]),
];

const ENTRIES: PortfolioEntry[] = [
  { kind: "fund", key: "VTI", amount: 6_000 },
  { kind: "fund", key: "VXUS", amount: 3_000 },
  { kind: "fund", key: "BND", amount: 1_000 },
];

const WEIGHTS: Record<string, number> = { VTI: 0.6, VXUS: 0.3, BND: 0.1 };

const LEDGER: Ledger = buildLedger({
  funds: FUNDS,
  weights: WEIGHTS,
  countries: COUNTRIES,
});

/**
 * The benchmark's own filing: VT holds four of the eight companies, at weights that give
 * the difference column a positive, a negative and an exact zero to print.
 *
 * c_apple is 21.00% of this portfolio against VT's 20.00% (+1.00), c_msft 18.00% against
 * 50.00% (-32.00), and c_treasury 10.00% against 10.00% — the case where the sign has no
 * side to be on and the bracket must not wear a colour.
 */
const VT_HOLDINGS: [string, number][] = [
  ["c_apple", 2_000],
  ["c_msft", 5_000],
  ["c_nvda", 2_000],
  ["c_treasury", 1_000],
];

const BENCHMARKED: Ledger = buildLedger({
  funds: FUNDS,
  weights: WEIGHTS,
  countries: COUNTRIES,
  benchmark: benchmarkFor(fund("VT", 100, VT_HOLDINGS)),
});

interface Options {
  entries?: PortfolioEntry[];
  ledger?: Ledger | null;
  lens?: Lens;
}

/**
 * A model shaped like the real one.
 *
 * It is cast because the real interface carries every portfolio mutator and the whole
 * release load state, and a fixture that stubbed all of them would be asserting its own
 * stub. The components read the fields below and nothing else; the mocks on `setLens` and
 * `openCompany` are the two the shell is supposed to call.
 */
function makeModel({ entries = [], ledger = null, lens = "companies" }: Options = {}) {
  const mode = "bp" as const;
  const total = entries.reduce((sum, entry) => sum + entry.amount, 0);
  return {
    ready: true,
    problem: null,
    release: { status: "ready", data: RELEASE, error: null },
    releaseAsOf: "2026-10-30.8",
    portfolio: {
      entries,
      mode,
      ready: true,
      problem: null,
      total,
      complete: total === 10_000,
      unallocatedBp: Math.max(0, 10_000 - total),
      overBp: Math.max(0, total - 10_000),
      add: vi.fn(() => "kept"),
      remove: vi.fn(),
      move: vi.fn(),
      setAmount: vi.fn(),
      equalise: vi.fn(),
      clear: vi.fn(),
      setMode: vi.fn(),
      replace: vi.fn(),
    },
    split: splitPortfolio(mode, entries),
    funds: FUNDS,
    pendingFunds: [],
    fundsError: null,
    securities: { rows: new Map(), missing: [], pending: false, error: null },
    countries: COUNTRIES,
    // The real model carries the same benchmark the ledger was built with; deriving it
    // here keeps the fixture from contradicting its own ledger.
    benchmark: ledger?.benchmark ? benchmarkFor(fund("VT", 100, VT_HOLDINGS)) : null,
    ledger,
    ledgerError: null,
    ledgerMode: "main-thread" as const,
    durationMs: null,
    hasHoldings: entries.some((entry) => entry.kind !== "cash"),
    hasEntries: entries.length > 0,
    complete: total === 10_000,
    lens,
    setLens: vi.fn(),
    companyId: null,
    openCompany: vi.fn(),
    fundByTicker: new Map(FUNDS.map((document) => [document.ticker, document])),
    countryOf: (companyId: string) => COUNTRIES[companyId] ?? null,
  } as unknown as WorkspaceModel;
}

/**
 * A ledger the size of a real portfolio: `count` companies through one fund.
 *
 * The Companies lens pages at 50 rows because a three-fund portfolio is 3,665 of them;
 * this is the same shape at a size a test can build in a millisecond, and it is what the
 * paging assertions below are measured against.
 */
function bigLedger(count: number): Ledger {
  const holdings: [string, number][] = Array.from({ length: count }, (_, index) => [
    `c_${index}`,
    10_000 / count,
  ]);
  const fundDocument = fund("BIG", 100, holdings);
  const countries: Record<string, string> = {};
  for (const [companyId] of holdings) countries[companyId] = "US";
  return buildLedger({
    funds: [fundDocument],
    weights: { BIG: 1 },
    countries,
  });
}

function renderWorkspace(options: Options = {}) {
  const model = makeModel(options);
  state.model = model;
  return { model, ...render(<Workspace />) };
}

afterEach(() => {
  cleanup();
  saved.length = 0;
});

/** A whole portfolio opens collapsed; the tests that read the form press Edit first. */
function openPane(): void {
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
}

describe("Workspace — the answer comes first", () => {
  it("carries the answer as five numbers in the strip, not a paragraph", () => {
    const { container } = renderWorkspace({ entries: ENTRIES, ledger: LEDGER });

    const strip = screen.getByRole("tablist", { name: "Lenses" });
    const tabs = within(strip).getAllByRole("tab");
    expect(tabs).toHaveLength(5);

    // The Companies tab is the count and what the portfolio behaves like.
    expect(tabs[0]?.textContent).toContain("behaves like");
    // The Markets tab names all three tiers, and "DM" matches "EM".
    expect(tabs[1]?.textContent).toContain("US ");
    expect(tabs[1]?.textContent).toContain("DM ");
    expect(tabs[1]?.textContent).toContain("EM ");
    // The Data quality tab is coverage and the oldest period behind it.
    expect(tabs[4]?.textContent).toContain("oldest");

    // The card is gone: the strip is the answer now, and nothing above it repeats it.
    expect(container.querySelector(".summary-box")).toBeNull();
  });

  it("puts the strip at the top of the results column, above the panel", () => {
    renderWorkspace({ entries: ENTRIES, ledger: LEDGER });

    const strip = screen.getByRole("tablist", { name: "Lenses" });
    const panel = screen.getByRole("tabpanel");
    expect(
      strip.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps the ten-largest fact at the top of the Companies lens", () => {
    renderWorkspace({ entries: ENTRIES, ledger: LEDGER });

    // The one fact the old card carried that no tab shows. It moved into the panel
    // rather than being dropped.
    const panel = screen.getByRole("tabpanel");
    expect(panel.textContent).toContain("of the mix");
  });

  it("still prints the prose on paper, where there is no fold to get under", () => {
    const { container } = renderWorkspace({ entries: ENTRIES, ledger: LEDGER });

    const print = container.querySelector(".print-only");
    expect(print?.querySelector(".answer")?.textContent).toContain(
      "You own 8 companies through 3 funds.",
    );
    expect(print?.querySelector(".answer__note")?.textContent).toContain("covered");
  });

  it("says what is missing instead of printing numbers for an incomplete portfolio", () => {
    const { container } = renderWorkspace({
      entries: ENTRIES.slice(0, 2),
    });

    // Nothing is shown for a portfolio that is not whole: one sentence with the number,
    // where the lenses would be, and no lens, table or action behind it.
    expect(container.querySelector(".summary-box")).toBeNull();
    expect(container.querySelector(".answer")).toBeNull();
    expect(screen.getByText(/10\.00% of your portfolio has no holding yet/)).toBeTruthy();
    expect(screen.queryByRole("tablist", { name: "Lenses" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy share link" })).toBeNull();
  });

  it("waits rather than showing a table before the filings arrive", () => {
    renderWorkspace({ entries: ENTRIES, ledger: null });

    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/You own 8 companies/)).toBeNull();
  });
});

describe("Workspace — the companies table", () => {
  it("carries the market edge in markup and the country in text", () => {
    renderWorkspace({ entries: ENTRIES, ledger: LEDGER });

    // The printable summary is a second table in the DOM (hidden on screen by CSS, which
    // jsdom does not apply), so every table query is scoped to the open lens.
    const panel = within(screen.getByRole("tabpanel"));
    const table = panel.getByRole("table");
    expect(table.className).toContain("tier-edge");
    expect(table.querySelector("caption")?.textContent).toContain("One row per company");

    const us = document.querySelector('tr[data-tier="US"]');
    expect(us).not.toBeNull();
    expect(us?.textContent).toContain("US");
    // The flag is derived from the code and is decoration: the glyph is `aria-hidden`
    // and the code beside it is the fact. A cell that prints the code alone is the
    // regression this holds — it shipped once, and a bare "US" reads as an abbreviation
    // rather than as a country.
    expect(us?.querySelector(".country-tag [aria-hidden='true']")?.textContent).toBe(
      flagEmoji("US"),
    );

    // A company the release cannot place keeps its row, loses only the colour.
    const unknown = document.querySelector('tr[data-country-missing="true"]');
    expect(unknown).not.toBeNull();
    expect(unknown?.textContent).toContain("no code");
    expect(unknown?.getAttribute("data-tier")).toBeNull();
  });

  it("prints the country code once, and the market only when it adds something", () => {
    renderWorkspace({ entries: ENTRIES, ledger: LEDGER });

    // The country cell is the second `td` on the row: rank, then country.
    const cell = (tier: string) =>
      document.querySelector(`tr[data-tier="${tier}"] td:nth-of-type(2)`)?.textContent;

    // A US company's market word is its own country code, so the cell says "US" once.
    // It shipped as "US US" — the code, then the tier named after the same country.
    expect(cell("US")).toBe(`${flagEmoji("US")} US`);

    // Every other country keeps the market, because "CH" does not answer it.
    expect(cell("DM")).toContain("Developed");
    expect(cell("EM")).toContain("Emerging");
  });

  it("prints the flag beside the country in the printable summary too", () => {
    renderWorkspace({ entries: ENTRIES, ledger: LEDGER });

    // The printable summary is a second table in the DOM, hidden on screen by CSS that
    // jsdom does not apply. It is the one surface a reader sees on paper, so it carries
    // the same flag-and-code pair as the screen rather than a bare code.
    const summary = screen.getByRole("region", { name: "Printable summary" });
    const tags = [...summary.querySelectorAll(".country-tag")];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      // The cell reads "<flag> <code>", so the code is the last whitespace-separated
      // token and the flag is the `aria-hidden` child in front of it.
      const code = tag.textContent?.trim().split(/\s+/).pop() ?? "";
      expect(code).toMatch(/^[A-Z]{2}$/);
      expect(tag.querySelector("[aria-hidden='true']")?.textContent).toBe(
        flagEmoji(code),
      );
    }
  });

  it("opens a company from the row's own control", () => {
    const { model } = renderWorkspace({ entries: ENTRIES, ledger: LEDGER });

    fireEvent.click(screen.getByRole("button", { name: "Open Company c_apple" }));
    expect(model.openCompany).toHaveBeenCalledWith("c_apple");
  });

  it("keeps the caption to one line and puts the method under the table", () => {
    renderWorkspace({ entries: ENTRIES, ledger: BENCHMARKED });

    const panel = within(screen.getByRole("tabpanel"));
    const table = panel.getByRole("table");
    const caption = table.querySelector("caption")?.textContent ?? "";

    // The operator's instruction (2026-11-03): the eight-sentence caption was a wall of
    // text above the table that nobody read. P-C-12 then made the one line a screen
    // reader's caption, so the sort's direction is announced by `aria-sort` on the header
    // instead of being printed twice. What is left is what the table is, how it is
    // ordered, and what it compares against.
    expect(caption).toContain("One row per company");
    expect(caption).toContain("Sorted by Your weight.");
    expect(caption).toContain("Benchmark: VT");
    expect(caption.length).toBeLessThan(120);

    // The method is one click away, closed by default, and it is the only copy: the
    // column meanings, the bracket's direction and the tier convention all live here.
    const method = panel.getByText("How to read this table").closest("details");
    expect(method).not.toBeNull();
    expect(method?.hasAttribute("open")).toBe(false);
    expect(method?.textContent).toContain("percentage points");
    expect(method?.textContent).toContain("MSCI-aligned country classification");
    expect(method?.textContent).toContain("every row, not this page");
  });

  it("sorts on a header and says so on the header and in the caption", () => {
    renderWorkspace({ entries: ENTRIES, ledger: LEDGER });

    const panel = within(screen.getByRole("tabpanel"));
    expect(
      panel.getByRole("columnheader", { name: "Company" }).getAttribute("aria-sort"),
    ).toBe("none");

    fireEvent.click(panel.getByRole("button", { name: "Company" }));

    expect(
      panel.getByRole("columnheader", { name: "Company" }).getAttribute("aria-sort"),
    ).toBe("ascending");
    expect(panel.getByRole("table").querySelector("caption")?.textContent).toContain(
      "Sorted by Company.",
    );
  });

  it("filters the table without touching the ledger", () => {
    renderWorkspace({ entries: ENTRIES, ledger: LEDGER });

    fireEvent.change(screen.getByLabelText("Filter companies"), {
      target: { value: "nestle" },
    });

    expect(screen.getByText(/1 of 8 companies/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Company c_apple" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open Company c_nestle" })).toBeTruthy();
  });
});

describe("Workspace — the holdings pane and the lenses", () => {
  it("shows each fund's coverage and reporting period on its row", () => {
    const { container } = renderWorkspace({ entries: ENTRIES, ledger: LEDGER });
    openPane();

    expect(screen.getByRole("button", { name: "Remove VTI" })).toBeTruthy();
    // The total is now one figure and its unit, so it is read as two nodes rather than
    // one string: the big number the visitor steers, and the whole it is a share of.
    expect(container.querySelector(".meter__value")?.textContent).toBe("100.00%");
    expect(container.querySelector(".meter__of")?.textContent).toBe("of 100.00%");
    expect(screen.getAllByText(/100\.0% covered/).length).toBeGreaterThan(0);
    // `formatDateLong` abbreviates the month, and the chip prints the period end.
    expect(screen.getAllByText("Jun 30, 2026").length).toBeGreaterThan(0);
  });

  it("colours the total's bar and its validator by whether the portfolio is whole", () => {
    const wholeRender = renderWorkspace({ entries: ENTRIES, ledger: LEDGER });
    openPane();

    // Whole: the bar wears the completed state, and the sentence is the green one.
    expect(wholeRender.container.querySelector(".meter__fill--whole")).not.toBeNull();
    expect(wholeRender.container.querySelector(".tally__gate--open")?.textContent).toBe(
      "Fully allocated",
    );
    expect(wholeRender.container.querySelector(".tally__gate--locked")).toBeNull();
    // The percentage is its own, larger figure beside the unit it is a share of.
    expect(wholeRender.container.querySelector(".meter__value")?.textContent).toBe(
      "100.00%",
    );
    expect(wholeRender.container.querySelector(".meter__of")?.textContent).toBe(
      "of 100.00%",
    );
    wholeRender.unmount();

    // Short: no completed bar, and the validator says how short in the red state.
    const shortRender = renderWorkspace({ entries: ENTRIES.slice(0, 1), ledger: LEDGER });
    expect(shortRender.container.querySelector(".meter__fill--whole")).toBeNull();
    expect(shortRender.container.querySelector(".tally__gate--locked")?.textContent).toBe(
      "40.00% unallocated",
    );
    expect(shortRender.container.querySelector(".meter__value")?.textContent).toBe(
      "60.00%",
    );
    shortRender.unmount();

    // Over: locked too — the red state carries both directions, not just short.
    const overRender = renderWorkspace({
      entries: [
        { kind: "fund", key: "VTI", amount: 6_000 },
        { kind: "fund", key: "VXUS", amount: 3_000 },
        { kind: "fund", key: "BND", amount: 3_000 },
      ],
      ledger: LEDGER,
    });
    expect(overRender.container.querySelector(".meter__fill--whole")).toBeNull();
    expect(overRender.container.querySelector(".tally__gate--locked")?.textContent).toBe(
      "20.00% over 100%",
    );
  });

  it("switches lens through the model, never through local state", () => {
    const { model } = renderWorkspace({ entries: ENTRIES, ledger: LEDGER });

    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe("lens-tab-companies");

    fireEvent.click(screen.getByRole("tab", { name: /^Markets/ }));
    expect(model.setLens).toHaveBeenCalledWith("markets");
  });

  it("links to the comparison with this mix on one side only", () => {
    renderWorkspace({ entries: ENTRIES, ledger: LEDGER });

    const compare = screen.getByRole("link", { name: /Compare/ });
    const href = compare.getAttribute("href") ?? "";
    expect(href.startsWith("/compare/#")).toBe(true);
    // A side of the comparison, not an empty hash: the fragment store now keeps a
    // one-sided comparison instead of clearing it, so the payload has to be there.
    expect(href.length).toBeGreaterThan("/compare/#".length);
  });

  it("adds a typed ticker through the store, once", async () => {
    const { model } = renderWorkspace({ entries: ENTRIES.slice(0, 2) });

    fireEvent.change(screen.getByLabelText("Add a fund, a stock, or cash"), {
      target: { value: "bnd" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(model.portfolio.add).toHaveBeenCalledWith("fund", "BND"));
    // One write per add: the row arrives at 0 and no second call re-weights it.
    expect(model.portfolio.setAmount).not.toHaveBeenCalled();
    expect(model.portfolio.replace).not.toHaveBeenCalled();
  });

  it("fills the unallocated rest with cash in a single write", () => {
    const { model } = renderWorkspace({ entries: ENTRIES.slice(0, 2) });

    fireEvent.click(screen.getByRole("button", { name: "Fill the rest with cash" }));

    expect(model.portfolio.replace).toHaveBeenCalledWith([
      ...ENTRIES.slice(0, 2),
      { kind: "cash", key: CASH_KEY, amount: 1_000 },
    ]);
  });

  it("pages 50 rows at a time, and says which rows of how many are showing", () => {
    renderWorkspace({ entries: ENTRIES, ledger: bigLedger(500) });

    const panel = within(screen.getByRole("tabpanel"));
    const table = panel.getByRole("table");
    const rows = () => Array.from(table.querySelectorAll("tbody tr"));
    const rankOf = (row: Element) => row.querySelector("td")?.textContent;

    // A page, not a window: fifty rows in the DOM, and no row-count to keep in step with
    // rows that are not there.
    expect(rows()).toHaveLength(50);
    expect(rankOf(rows()[0] as Element)).toBe("1");
    expect(rankOf(rows()[49] as Element)).toBe("50");
    expect(table.hasAttribute("aria-rowcount")).toBe(false);
    // Rows take their own height — the fund list on a row wraps — so nothing is pinned to
    // a row constant.
    expect(rows()[0]?.getAttribute("style")).toBeNull();

    // The pager says which rows these are, so nothing on the page claims to be the whole
    // table. It is the only place that says it: the caption is one line (2026-11-03).
    expect(panel.getByText("Showing rows 1–50 of 500 · page 1 of 10")).toBeTruthy();
    expect(panel.getByRole("button", { name: "Previous" }).hasAttribute("disabled")).toBe(
      true,
    );

    fireEvent.click(panel.getByRole("button", { name: "Next" }));

    // Row 51 of the sorted table, and the announcement is polite: it is a status the
    // screen reader reads out without moving focus.
    expect(rows()).toHaveLength(50);
    expect(rankOf(rows()[0] as Element)).toBe("51");
    expect(rankOf(rows()[49] as Element)).toBe("100");
    expect(panel.getByText("Showing rows 51–100 of 500 · page 2 of 10")).toBeTruthy();
    expect(panel.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("goes back to the first page when the sort or the filter changes the list", () => {
    renderWorkspace({ entries: ENTRIES, ledger: bigLedger(500) });

    const panel = within(screen.getByRole("tabpanel"));
    const firstRank = () =>
      panel.getByRole("table").querySelector("tbody tr td")?.textContent;

    fireEvent.click(panel.getByRole("button", { name: "Next" }));
    expect(firstRank()).toBe("51");

    fireEvent.change(panel.getByLabelText("Filter companies"), {
      target: { value: "c_1" },
    });
    // A different list, so the old page number would point at rows that are not there.
    expect(firstRank()).toBe("1");
    expect(panel.getByText(/page 1 of/)).toBeTruthy();
  });

  it("names every fund on a row rather than counting the rest behind a number", () => {
    const threeWays = buildLedger({
      funds: [
        fund("AAA", 100, [["c_apple", 5_000]]),
        fund("BBB", 100, [["c_apple", 3_000]]),
        fund("CCC", 100, [["c_apple", 2_000]]),
      ],
      weights: { AAA: 0.5, BBB: 0.3, CCC: 0.2 },
      countries: COUNTRIES,
    });
    renderWorkspace({ entries: ENTRIES, ledger: threeWays });

    const panel = within(screen.getByRole("tabpanel"));
    const row = panel.getByRole("row", { name: /c_apple/ });

    // All three, largest part of the mix first, each with the share it contributes.
    const listed = Array.from(row.querySelectorAll("li")).map((item) => item.textContent);
    expect(listed).toEqual(["AAA 25.00%", "BBB 9.00%", "CCC 4.00%"]);
    // And no "+2": the attribution a reader would have had to open a tooltip for is the
    // attribution the row shows.
    expect(row.textContent).not.toMatch(/\+\d/);
  });

  it("shows the benchmark beside your weight, and no column at all without one", () => {
    const benchmarked = renderWorkspace({ entries: ENTRIES, ledger: BENCHMARKED });
    const panel = within(screen.getByRole("tabpanel"));

    // The label each header prints, without the header tip's ⓘ: the glyph is decoration
    // (`aria-hidden`), and the tip's accessible name is "About {label}" (P-C-13).
    const headers = panel
      .getAllByRole("columnheader")
      .map(
        (header) =>
          header.querySelector("button.table__sort")?.textContent?.trim() ??
          header.firstChild?.textContent?.trim(),
      );
    expect(headers).toEqual([
      "Rank",
      "Company",
      "Country, market",
      "Your weight",
      "VT",
      "Change vs VT",
      "Held by",
      "From your funds",
    ]);

    // VT's weight is a share of VT's own NAV, printed as a share — not a holding, and not
    // a weight of the visitor's. The cells are read by position, so a column that drifted
    // would fail here rather than print the right number under the wrong heading.
    const apple = panel.getByRole("row", { name: /c_apple/ });
    const cells = Array.from(apple.querySelectorAll("td")).map(
      (cell) => cell.textContent,
    );
    // The company name is the row header, so the cells are rank, country, weight, VT,
    // change.
    expect(cells[0]).toBe("1");
    expect(cells[2]).toBe("21.00%");
    expect(cells[3]).toBe("20.00%");
    expect(cells[4]).toBe("+1.00%");

    benchmarked.unmount();

    renderWorkspace({ entries: ENTRIES, ledger: LEDGER });
    const bare = within(screen.getByRole("tabpanel"));
    const bareHeaders = bare
      .getAllByRole("columnheader")
      .map((header) => header.textContent?.trim());

    // Absent, not zeros: a comparison with a benchmark the release does not publish would
    // be a number about nothing.
    expect(bareHeaders).not.toContain("VT");
    expect(bareHeaders).not.toContain("Change vs VT");
    expect(bareHeaders).toHaveLength(6);
    // The caption names the benchmark and the disclosure explains it; with no benchmark
    // both are absent rather than empty.
    expect(bare.getByRole("table").querySelector("caption")?.textContent).not.toContain(
      "Benchmark:",
    );
    expect(bare.queryByText("How to read this table")).not.toBeNull();
    expect(
      bare.getByText("How to read this table").closest("details")?.textContent,
    ).not.toContain("percentage points");
  });

  it("gives each fund one hue for the whole table, repeated as a dot beside its name", () => {
    renderWorkspace({ entries: ENTRIES, ledger: LEDGER });
    const panel = screen.getByRole("tabpanel");

    // Every segment names its fund in its title; a fund's segments share one slot on
    // every row, and two funds never share one (the example has fewer than eight).
    const slotByFund = new Map<string, Set<string>>();
    for (const segment of panel.querySelectorAll<HTMLElement>(".rowbar__fill[title]")) {
      const fund = segment.title.split(":")[0] as string;
      if (fund.endsWith("(direct)")) continue;
      const slot = segment.dataset.fundSlot;
      expect(slot).toMatch(/^[1-8]$/);
      slotByFund.set(fund, (slotByFund.get(fund) ?? new Set()).add(slot as string));
    }
    expect(slotByFund.size).toBeGreaterThan(1);
    for (const slots of slotByFund.values()) expect(slots.size).toBe(1);
    const distinct = new Set([...slotByFund.values()].map((slots) => [...slots][0]));
    expect(distinct.size).toBe(slotByFund.size);

    // The legend: each named fund carries a hidden dot in the same slot as its segment.
    const dots = panel.querySelectorAll<HTMLElement>(
      '[aria-hidden="true"][data-fund-slot]',
    );
    expect(dots.length).toBeGreaterThan(0);
    for (const dot of dots) {
      const name = dot.nextElementSibling?.textContent ?? "";
      expect(slotByFund.get(name)?.has(dot.dataset.fundSlot as string)).toBe(true);
    }
  });

  it("prints the difference with its sign and its colour, and no colour at zero", () => {
    renderWorkspace({ entries: ENTRIES, ledger: BENCHMARKED });

    const panel = within(screen.getByRole("tabpanel"));

    // Above the benchmark: green, and the sign says so on its own.
    expect(panel.getByText("+1.00%").className).toBe("delta delta--up");
    // Below it: red.
    expect(panel.getByText("-32.00%").className).toBe("delta delta--down");
    // Exactly level: the bracket is the whole answer, with no side to colour.
    // `0.00%` is also a weight elsewhere in the table, so it is read from the delta cells.
    const level = Array.from(
      screen.getByRole("tabpanel").querySelectorAll<HTMLElement>(".delta"),
    ).filter((cell) => cell.textContent === "0.00%");
    expect(level.map((cell) => cell.className)).toEqual(["delta"]);
  });

  it("exports every company, not the page", () => {
    renderWorkspace({ entries: ENTRIES, ledger: bigLedger(500) });

    fireEvent.click(
      within(screen.getByRole("tabpanel")).getByRole("button", {
        name: /Download this table/,
      }),
    );

    const text = saved.at(-1) ?? "";
    const lines = text.trimEnd().split("\n");

    // A header and 500 rows: the file is the ledger, whatever page the table drew.
    expect(lines).toHaveLength(501);
    // Both benchmark columns travel with the file, and with no benchmark they are empty
    // rather than zeros — a zero in a spreadsheet is a measurement.
    expect(lines[0]).toContain("vt_weight_pct");
    expect(lines[0]).toContain("change_vs_vt_pp");
    const firstRow = (lines[1] ?? "").split(",");
    expect(firstRow).toHaveLength(10);
    expect(firstRow[4]).toBe("");
    expect(firstRow[5]).toBe("");
  });

  it("writes both benchmark numbers into the file a spreadsheet can subtract", () => {
    renderWorkspace({ entries: ENTRIES, ledger: BENCHMARKED });

    fireEvent.click(
      within(screen.getByRole("tabpanel")).getByRole("button", {
        name: /Download this table/,
      }),
    );

    const lines = (saved.at(-1) ?? "").trimEnd().split("\n");
    // Your weight, VT's weight inside its own NAV, and the signed difference in percentage
    // points: the page's meaning, in cells a formula can use.
    expect(lines.find((line) => line.startsWith("c_apple,"))).toContain(
      ",21.00,20.00,+1.00,",
    );
    // The zero keeps its place and its sign-free number.
    expect(lines.find((line) => line.startsWith("c_treasury,"))).toContain(
      ",10.00,10.00,0.00,",
    );
  });

  it("renders the empty state, with the example labelled as an example", () => {
    renderWorkspace();

    expect(screen.getByText("No holdings yet")).toBeTruthy();
    // The caption, not the constant: the card says it in the brief's words, and the chip
    // that carries `EXAMPLE_LABEL` appears once the example is open.
    expect(screen.getByText("Example, not a recommendation.")).toBeTruthy();
    // A portfolio with no entries has no chip bar to collapse.
    expect(screen.queryByRole("button", { name: "Edit holdings" })).toBeNull();
  });

  it("puts the empty card, the lenses, then the actions in that order", () => {
    renderWorkspace();

    const card = screen.getByRole("heading", { name: "No holdings yet" });
    const lenses = screen.getByRole("tablist", { name: "Lenses" });
    const actions = screen.getByRole("button", { name: "Print summary" });

    // The module in the middle is the five-lens tablist, not some other tab strip.
    expect(
      within(lenses)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Companies", "Markets", "Funds", "Overlap", "Data Quality"]);

    const comesBefore = (first: Node, second: Node) =>
      (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

    expect(comesBefore(card, lenses)).toBe(true);
    expect(comesBefore(lenses, actions)).toBe(true);
  });

  it("names the example's funds without printing its weights first", () => {
    renderWorkspace();

    const card = screen
      .getByRole("heading", { name: "No holdings yet" })
      .closest(".empty");
    expect(card).not.toBeNull();

    // Tickers only: the percentages arrive with the holdings pane after "Open the
    // example", not before the visitor has chosen anything.
    const chips = Array.from(card?.querySelectorAll(".chip") ?? []).map((chip) =>
      chip.textContent?.trim(),
    );
    expect(chips).toEqual([...EXAMPLE_TICKERS]);
    expect(card?.textContent).not.toContain("14.29%");
  });

  it("leaves the empty state out once the portfolio has entries", () => {
    renderWorkspace({ entries: ENTRIES, ledger: LEDGER });

    expect(screen.queryByRole("heading", { name: "No holdings yet" })).toBeNull();
    expect(screen.queryByText("Example, not a recommendation.")).toBeNull();
  });
});

/**
 * The lens strip's two densities.
 *
 * jsdom has no IntersectionObserver and no layout, so the observer is a stub whose
 * callback the test fires by hand, and the top bar's slot is a div the test adds to the
 * document — the docked copy portals into it. Everything else is the real component.
 */
class FakeObserver {
  static instances: FakeObserver[] = [];
  readonly callback: IntersectionObserverCallback;
  root = null;
  rootMargin = "";
  thresholds = [];
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  fire(isIntersecting: boolean, top: number) {
    this.callback(
      [
        {
          isIntersecting,
          boundingClientRect: { top } as DOMRect,
          target: document.createElement("div"),
        } as unknown as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }
}

describe("Workspace — the docked lens strip", () => {
  const realScrollTo = window.scrollTo;

  beforeEach(() => {
    FakeObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    const slot = document.createElement("div");
    slot.id = "topbar-slot";
    document.body.appendChild(slot);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.scrollTo = realScrollTo;
    document.getElementById("topbar-slot")?.remove();
  });

  it("exposes one tablist at a time, and swaps them when the strip docks", () => {
    renderWorkspace({ entries: ENTRIES, ledger: LEDGER });

    const full = document.getElementById("lens-strip");
    const docked = document.getElementById("lens-dock");

    // In view: the full strip is the live tablist and the docked copy is hidden from
    // the accessibility tree, so a keyboard user never meets two tab sequences.
    expect(full?.getAttribute("aria-hidden")).toBeNull();
    expect(docked?.getAttribute("aria-hidden")).toBe("true");
    expect(docked?.hasAttribute("inert")).toBe(true);

    act(() => {
      FakeObserver.instances[0]?.fire(false, -100);
    });

    // Docked: the other way round, and the panel follows whichever is live.
    expect(document.getElementById("lens-strip")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(document.getElementById("lens-strip")?.hasAttribute("inert")).toBe(true);
    expect(document.getElementById("lens-dock")?.getAttribute("aria-hidden")).toBeNull();
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
      "lens-tab-dock-companies",
    );
  });

  it("shows a number on the active docked tab only", () => {
    renderWorkspace({ entries: ENTRIES, ledger: LEDGER });
    act(() => {
      FakeObserver.instances[0]?.fire(false, -100);
    });

    const docked = document.getElementById("lens-dock") as HTMLElement;
    const tabs = within(docked).getAllByRole("tab", { hidden: true });
    const selected = tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
    expect(selected?.textContent).toContain("Companies");
    expect(selected?.textContent).toMatch(/\d/);
    // The other four are text only.
    for (const tab of tabs) {
      if (tab.getAttribute("aria-selected") === "true") continue;
      expect(tab.textContent).not.toMatch(/\d/);
    }
  });

  it("switches the lens and scrolls to the top of the panel when a docked tab is clicked", () => {
    const { model } = renderWorkspace({ entries: ENTRIES, ledger: LEDGER });
    act(() => {
      FakeObserver.instances[0]?.fire(false, -100);
    });

    const docked = document.getElementById("lens-dock") as HTMLElement;
    fireEvent.click(within(docked).getByRole("tab", { name: /^Overlap/, hidden: true }));

    expect(model.setLens).toHaveBeenCalledWith("overlap");
    // The reader is put at the panel's top, offset by the top bar's height, rather than
    // left in the middle of a table they have never seen.
    expect(window.scrollTo).toHaveBeenCalled();
  });

  it("keeps arrow keys working in the docked density", () => {
    const { model } = renderWorkspace({ entries: ENTRIES, ledger: LEDGER });
    act(() => {
      FakeObserver.instances[0]?.fire(false, -100);
    });

    const docked = document.getElementById("lens-dock") as HTMLElement;
    const first = within(docked).getAllByRole("tab", { hidden: true })[0] as HTMLElement;
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(model.setLens).toHaveBeenCalledWith("markets");
  });

  it("disables the tabs and says why when there is no portfolio", () => {
    renderWorkspace({ entries: [], ledger: null });

    const strip = screen.getByRole("tablist", { name: "Lenses" });
    for (const tab of within(strip).getAllByRole("tab")) {
      expect(tab.hasAttribute("disabled")).toBe(true);
    }
    expect(strip.getAttribute("aria-describedby")).toBe("lens-disabled-note");
    // P-E-08: the sentence is no longer a paragraph under the strip. It is the tabs'
    // description — still reachable, now visually hidden — and each tab carries it as a
    // tooltip for a reader without a screen reader.
    expect(screen.getByText("Add a holding to open this lens")).toBeTruthy();
    for (const tab of within(strip).getAllByRole("tab")) {
      expect(tab.getAttribute("title")).toBe("Add a holding to open this lens");
    }
  });
});

describe("Workspace — Show results puts the form away", () => {
  it("starts collapsed for a link that already carries a whole portfolio", () => {
    renderWorkspace({ entries: ENTRIES, ledger: LEDGER });

    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show results" })).toBeNull();
    // Collapsed shows the same weights, only smaller, and the results are already up.
    expect(screen.getByRole("tablist", { name: "Lenses" })).toBeTruthy();
  });

  it("starts open for a portfolio that is not whole yet, with the button held back", () => {
    const { model } = renderWorkspace({ entries: ENTRIES.slice(0, 1), ledger: LEDGER });

    const button = screen.getByRole("button", { name: "Show results" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    // The reason is the sentence above it, reachable from the button.
    const reason = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toContain("40.00% unallocated");

    fireEvent.click(button);

    // Nothing happened: still the full form, same portfolio.
    expect(screen.getByRole("button", { name: "Show results" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(model.portfolio.replace).not.toHaveBeenCalled();
  });

  it("starts open for an empty portfolio, with no button to press", () => {
    renderWorkspace();

    expect(screen.queryByRole("button", { name: "Show results" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("collapses to the compact list and moves focus to the results", async () => {
    const { container } = renderWorkspace({ entries: ENTRIES, ledger: LEDGER });
    openPane();
    expect(screen.queryByRole("button", { name: "Collapse" })).toBeNull();
    const button = screen.getByRole("button", { name: "Show results" });
    expect(button.getAttribute("aria-disabled")).toBeNull();

    fireEvent.click(button);

    expect(screen.queryByRole("button", { name: "Show results" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(container.querySelector("#results-region")),
    );
  });

  it("brings the form back, amounts intact, when Edit is pressed", () => {
    renderWorkspace({ entries: ENTRIES, ledger: LEDGER });
    openPane();
    fireEvent.click(screen.getByRole("button", { name: "Show results" }));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByRole("button", { name: "Show results" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove VTI" })).toBeTruthy();
  });
});

describe("Workspace — amounts are written as they are typed", () => {
  it("writes each keystroke through the store, with no blur needed", () => {
    const { model } = renderWorkspace({ entries: ENTRIES.slice(0, 2), ledger: LEDGER });
    const field = screen.getByLabelText("Amount for VTI, in percent");

    fireEvent.change(field, { target: { value: "4" } });
    expect(model.portfolio.setAmount).toHaveBeenLastCalledWith("fund", "VTI", 400);
    fireEvent.change(field, { target: { value: "40" } });
    expect(model.portfolio.setAmount).toHaveBeenLastCalledWith("fund", "VTI", 4_000);
    // Half-typed text is written as what leaving the field would have written.
    fireEvent.change(field, { target: { value: "12." } });
    expect(model.portfolio.setAmount).toHaveBeenLastCalledWith("fund", "VTI", 1_200);
  });

  it("keeps the number a whole row is capped at, and writes nothing for an empty field", () => {
    const { model } = renderWorkspace({ entries: ENTRIES.slice(0, 2), ledger: LEDGER });
    const field = screen.getByLabelText("Amount for VTI, in percent");

    fireEvent.change(field, { target: { value: "150" } });
    expect(model.portfolio.setAmount).toHaveBeenLastCalledWith("fund", "VTI", 10_000);

    vi.mocked(model.portfolio.setAmount).mockClear();
    fireEvent.change(field, { target: { value: "" } });
    expect(model.portfolio.setAmount).not.toHaveBeenCalled();
  });
});

describe("Workspace — nothing is shown until the portfolio is submitted", () => {
  it("holds a whole portfolio back until Show results, then shows it", () => {
    const view = renderWorkspace({ entries: ENTRIES.slice(0, 2) });
    expect(screen.queryByRole("tablist", { name: "Lenses" })).toBeNull();

    // The visitor fills the last gap by hand: whole now, but not submitted.
    state.model = makeModel({ entries: ENTRIES, ledger: LEDGER });
    view.rerender(<Workspace />);
    expect(screen.queryByRole("tablist", { name: "Lenses" })).toBeNull();
    expect(
      screen.getByText(/Your 3 holdings total 100\.00%\. Press Show results/),
    ).toBeTruthy();

    // The form's own button and the placeholder's do the same thing.
    fireEvent.click(
      screen.getAllByRole("button", { name: "Show results" })[0] as HTMLElement,
    );

    expect(screen.getByRole("tablist", { name: "Lenses" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("shows a whole portfolio that arrives in a link, which somebody already submitted", () => {
    renderWorkspace({ entries: ENTRIES, ledger: LEDGER });

    expect(screen.getByRole("tablist", { name: "Lenses" })).toBeTruthy();
    expect(screen.queryByText(/Press Show results to see/)).toBeNull();
  });

  it("steps the results back when a submitted portfolio is edited", () => {
    const view = renderWorkspace({ entries: ENTRIES, ledger: LEDGER });
    expect(screen.getByRole("tablist", { name: "Lenses" })).toBeTruthy();

    // 50/30/20 is still whole, but it is not the portfolio that was submitted.
    state.model = makeModel({
      entries: [
        { kind: "fund", key: "VTI", amount: 5_000 },
        { kind: "fund", key: "VXUS", amount: 3_000 },
        { kind: "fund", key: "BND", amount: 2_000 },
      ],
      ledger: LEDGER,
    });
    view.rerender(<Workspace />);

    expect(screen.queryByRole("tablist", { name: "Lenses" })).toBeNull();
    expect(
      screen.getByText(/Your 3 holdings total 100\.00%\. Press Show results/),
    ).toBeTruthy();
  });

  it("keeps the results when only the order of the rows changes", () => {
    const view = renderWorkspace({ entries: ENTRIES, ledger: LEDGER });

    state.model = makeModel({ entries: [...ENTRIES].reverse(), ledger: LEDGER });
    view.rerender(<Workspace />);

    expect(screen.getByRole("tablist", { name: "Lenses" })).toBeTruthy();
  });
});

describe("Workspace — a clean paste that totals 100% submits itself", () => {
  async function pasteList(text: string) {
    const view = renderWorkspace();
    fireEvent.change(screen.getByLabelText("Holdings to paste, one per line"), {
      target: { value: text },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Add \d+ holdings?$/ }));
    return view;
  }

  it("collapses to the list and shows the results, with the note carried over", async () => {
    const view = await pasteList("VTI 60\nVXUS 30\nBND 10");
    const { model } = view;
    await waitFor(() => expect(model.portfolio.replace).toHaveBeenCalledWith(ENTRIES));

    // The store (mocked here) now holds what was pasted.
    state.model = makeModel({ entries: ENTRIES, ledger: LEDGER });
    view.rerender(<Workspace />);

    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Lenses" })).toBeTruthy();
    expect(
      screen.getByText(/Added 3 holdings\. Check the amounts against your own split/),
    ).toBeTruthy();
  });

  it("stays open when a line is dropped, even if what was added totals 100%", async () => {
    // The third line repeats the second, so the paste is not clean: something was left out.
    const view = await pasteList("VTI 60\nVXUS 40\nVXUS 40");
    await waitFor(() => expect(view.model.portfolio.replace).toHaveBeenCalled());

    state.model = makeModel({
      entries: [
        { kind: "fund", key: "VTI", amount: 6_000 },
        { kind: "fund", key: "VXUS", amount: 4_000 },
      ],
      ledger: LEDGER,
    });
    view.rerender(<Workspace />);

    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Lenses" })).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Show results" }).length,
    ).toBeGreaterThan(0);
  });

  it("stays open when the list does not total 100%", async () => {
    const view = await pasteList("VTI 60\nVXUS 30");
    await waitFor(() => expect(view.model.portfolio.replace).toHaveBeenCalled());

    state.model = makeModel({ entries: ENTRIES.slice(0, 2), ledger: LEDGER });
    view.rerender(<Workspace />);

    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Lenses" })).toBeNull();
  });
});
