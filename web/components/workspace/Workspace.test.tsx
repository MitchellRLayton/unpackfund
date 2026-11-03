import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildLedger } from "@/lib/aggregate";
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
  useTickers: () => ({ status: "ready", data: ["VTI", "VXUS", "BND"], error: null }),
  useCatalogue: () => ({ status: "idle", data: null, error: null }),
  useFunds: () => ({ funds: [VTI, VXUS, BND], pending: [], error: null }),
  useBenchmark: () => ({ status: "idle", data: null, error: null }),
  useCountries: () => COUNTRIES,
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
    benchmark: ledger?.benchmark ?? null,
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

describe("Workspace — the answer comes first", () => {
  it("counts companies and funds before any table is shown", () => {
    const { container } = renderWorkspace({ entries: ENTRIES, ledger: LEDGER });

    const answer = container.querySelector(".answer");
    expect(answer?.textContent).toContain("You own 8 companies through 3 funds.");
    // The coverage note is part of the answer, not a footnote elsewhere.
    expect(container.querySelector(".answer__note")?.textContent).toContain("covered");
  });

  it("says what is missing instead of printing numbers for an incomplete portfolio", () => {
    const { container } = renderWorkspace({
      entries: ENTRIES.slice(0, 2),
    });

    const answer = container.querySelector(".answer");
    expect(answer?.textContent).toContain("Your percentages add up to 90.00%");
    expect(answer?.textContent).toContain("accounting for nothing");
    // The lens refuses for the same reason, in its own words.
    expect(screen.getByText("The portfolio is not whole yet")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
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

    // A company the release cannot place keeps its row, loses only the colour.
    const unknown = document.querySelector('tr[data-country-missing="true"]');
    expect(unknown).not.toBeNull();
    expect(unknown?.textContent).toContain("no code");
    expect(unknown?.getAttribute("data-tier")).toBeNull();
  });

  it("opens a company from the row's own control", () => {
    const { model } = renderWorkspace({ entries: ENTRIES, ledger: LEDGER });

    fireEvent.click(screen.getByRole("button", { name: "Open Company c_apple" }));
    expect(model.openCompany).toHaveBeenCalledWith("c_apple");
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
      "Sorted by Company, A first",
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
    renderWorkspace({ entries: ENTRIES, ledger: LEDGER });

    expect(screen.getByRole("button", { name: "Remove VTI" })).toBeTruthy();
    // The total, the two qualifiers, and the meter's own words.
    expect(screen.getByText("100.00% of 100.00%")).toBeTruthy();
    expect(screen.getAllByText(/100\.0% covered/).length).toBeGreaterThan(0);
    // `formatDateLong` abbreviates the month, and the chip prints the period end.
    expect(screen.getAllByText("Jun 30, 2026").length).toBeGreaterThan(0);
  });

  it("switches lens through the model, never through local state", () => {
    const { model } = renderWorkspace({ entries: ENTRIES, ledger: LEDGER });

    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe("lens-tab-companies");

    fireEvent.click(screen.getByRole("tab", { name: "Markets" }));
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

    // Both the caption and the announcement say which rows these are, so nothing on the
    // page claims to be the whole table.
    expect(table.querySelector("caption")?.textContent).toContain("500 companies in all");
    expect(table.querySelector("caption")?.textContent).toContain("rows 1–50 of 500");
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
    expect(panel.getByRole("table").querySelector("caption")?.textContent).toContain(
      "page 1 of",
    );
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

    const headers = panel
      .getAllByRole("columnheader")
      .map((header) => header.textContent?.trim());
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
    expect(cells[4]).toBe("(+1.00%)");

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
    expect(bare.getByRole("table").querySelector("caption")?.textContent).not.toContain(
      "VT is the Vanguard",
    );
  });

  it("prints the difference with its sign and its colour, and no colour at zero", () => {
    renderWorkspace({ entries: ENTRIES, ledger: BENCHMARKED });

    const panel = within(screen.getByRole("tabpanel"));

    // Above the benchmark: green, and the sign says so on its own.
    expect(panel.getByText("(+1.00%)").className).toBe("delta delta--up");
    // Below it: red.
    expect(panel.getByText("(-32.00%)").className).toBe("delta delta--down");
    // Exactly level: the bracket is the whole answer, with no side to colour.
    expect(panel.getByText("(0.00%)").className).toBe("delta");
  });

  it("exports every company, not the page", () => {
    renderWorkspace({ entries: ENTRIES, ledger: bigLedger(500) });

    fireEvent.click(
      within(screen.getByRole("tabpanel")).getByRole("button", { name: /Export/ }),
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
      within(screen.getByRole("tabpanel")).getByRole("button", { name: /Export/ }),
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

    expect(screen.getByText("Nothing in this portfolio yet")).toBeTruthy();
    expect(
      screen.getAllByText("Example portfolio, not a recommendation.").length,
    ).toBeGreaterThan(0);
    // A portfolio with no entries has no chip bar to collapse.
    expect(screen.queryByRole("button", { name: "Edit holdings" })).toBeNull();
  });
});
