/**
 * The style columns' sorting and the class picker (POC, plan §9.3).
 *
 * Two behaviours are worth a test rather than a screenshot: sorting by `Change vs style`
 * orders by *that* benchmark and follows the picker when the reader changes it, and the
 * sort falls back to `Your weight ↓` when the style columns disappear — otherwise the
 * table would be ordered by a column nobody can see.
 *
 * The fixture is built through the real gate and composite builder, so a change to either
 * shows up here as a number that moved rather than as a string that still matches.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  blendWeights,
  compositeFromDocuments,
  resolveStyleBenchmark,
} from "@/lib/style-benchmark";
import { captionFor } from "@/lib/use-style-benchmark";
import { STYLE_CLASS_BY_ID } from "@/lib/style-registry";
import { withEffective } from "@/lib/testing/ledger";
import type {
  FundDocument,
  Holding,
  Ledger,
  LedgerRow,
  ReleaseDescriptor,
} from "@/lib/types";
import type { WorkspaceModel } from "@/lib/use-workspace";

import { CompaniesLens } from "./CompaniesLens";

afterEach(cleanup);

const VT = { company_id: "c_1", weight: 0.02 };

function holding(companyId: string, weightBp: number): Holding {
  return {
    company_id: companyId,
    name: companyId,
    ticker: null,
    asset_cat: "equity",
    weight_bp: weightBp,
  };
}

function document(ticker: string, holdings: [string, number][]): FundDocument {
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
    coverage_pct: 99,
    holdings: holdings.map(([companyId, weightBp]) => holding(companyId, weightBp)),
    metrics: { hhi: 0, hhi_pct2: 0, effective_n: 0, top10_pct: 0 },
    warnings: [],
  };
}

function row(
  companyId: string,
  weight: number,
  benchmarkWeight: number | null,
): LedgerRow {
  return {
    company_id: companyId,
    name: companyId.toUpperCase(),
    ticker: null,
    country: "US",
    weight,
    benchmark_weight: benchmarkWeight,
    holder_count: 1,
    held_directly: false,
    sources: [{ kind: "fund", ref: "AVUV", weight }],
  };
}

const ROWS = [
  // c_abc is a big position that the US benchmark holds and the Intl one does not.
  row("c_abc", 0.5, VT.weight),
  row("c_def", 0.3, 0.01),
  row("c_ghi", 0.2, null),
];

// Built through the real effective-holdings function: the summary block above the table
// reads it, and a hand-written pair would crash on the shape rather than on the maths.
function ledgerOf(rows: LedgerRow[]): Ledger {
  // Built through the real effective-holdings function: the summary block above the table
  // reads it, and a hand-written pair would crash on the shape rather than on the maths.
  return withEffective({
    rows,
    funds: [],
    benchmark: {
      ticker: "VT",
      name: "Vanguard Total World Stock ETF",
      as_of: "2026-09-30",
    },
    unmapped: [],
  } as unknown as Omit<Ledger, "effective">);
}

const LEDGER: Ledger = ledgerOf(ROWS);

const US_MEMBERS = ["VBR", "IJS", "IWN"];
const INTL_MEMBERS = ["AVDV", "DISV", "ISVL"];

/** The two classes' composites, from documents whose weights are easy to read back. */
const COMPOSITES = {
  US_SCV: compositeFromDocuments("US_SCV", [
    document("VBR", [["c_abc", 2000]]),
    document("IJS", [
      ["c_abc", 1000],
      ["c_def", 3000],
    ]),
    document("IWN", [["c_def", 1000]]),
  ]),
  INTL_SCV: compositeFromDocuments("INTL_SCV", [
    document("AVDV", [["c_def", 2000]]),
    document("DISV", [["c_ghi", 4000]]),
    document("ISVL", [["c_ghi", 2000]]),
  ]),
};

function styleState() {
  const gate = resolveStyleBenchmark(
    [
      { ticker: "AVUV", weight: 0.6 },
      { ticker: "AVDV", weight: 0.4 },
    ],
    {
      // A per-ticker mix: a 99%-US answer for AVDV would fail the 90% developed test, which
      // is a fixture bug that looks exactly like a gate bug.
      regionMix: (ticker) =>
        ticker === "AVDV"
          ? { us: 0.01, dm: 0.98, em: 0, unplaced: 0.01 }
          : { us: 0.99, dm: 0, em: 0, unplaced: 0.01 },
    },
  );
  if (!gate.eligible) throw new Error("fixture gate should pass");
  const us = COMPOSITES.US_SCV;
  const intl = COMPOSITES.INTL_SCV;
  // The real blend, so the fixture cannot disagree with the product about allocation.
  const weights = blendWeights(
    gate.classes,
    new Map([
      ["US_SCV", us],
      ["INTL_SCV", intl],
    ]),
  );
  const names: Record<string, { name: string; ticker: string | null }> = {};
  const holders: Record<string, number> = {};
  for (const composite of [us, intl]) {
    for (const [companyId, identity] of Object.entries(composite.names))
      names[companyId] ??= identity;
    for (const [companyId, count] of Object.entries(composite.holders)) {
      holders[companyId] = Math.max(holders[companyId] ?? 0, count);
    }
  }
  return {
    gate,
    weights,
    names,
    holders,
    activeShare: 0.4,
    classes: [
      { styleClass: STYLE_CLASS_BY_ID.get("US_SCV")!, composite: us },
      { styleClass: STYLE_CLASS_BY_ID.get("INTL_SCV")!, composite: intl },
    ],
    asOf: "2026-09-30",
    caption: captionFor(gate, [
      { styleClass: STYLE_CLASS_BY_ID.get("US_SCV")!, composite: us },
      { styleClass: STYLE_CLASS_BY_ID.get("INTL_SCV")!, composite: intl },
    ]),
    holdsBenchmark: false,
    dropped: [],
  };
}

function model(
  withStyle = true,
  fundWeights: Record<string, number> = {},
  ledger: Ledger = LEDGER,
): WorkspaceModel {
  return {
    ready: true,
    problem: null,
    release: { status: "ready", data: {} as ReleaseDescriptor },
    releaseAsOf: "2026-11-09.1",
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
    split: { fundWeights, direct: [], cash: 0, invested: 1, unallocated: 0 },
    funds: [],
    style: withStyle
      ? { state: styleState(), gate: styleState().gate, pending: [] }
      : { state: null, gate: null, pending: [] },
    pendingFunds: [],
    fundsError: null,
    securities: { rows: new Map(), pending: [], error: null },
    countries: {},
    benchmark: null,
    ledger,
    ledgerError: null,
    ledgerMode: "worker",
    durationMs: 1,
    hasHoldings: true,
    hasEntries: true,
    complete: true,
    lens: "companies",
    setLens: () => {},
    companyId: null,
    openCompany: () => {},
    fundByTicker: new Map(),
    countryOf: () => "US",
    contested: {},
  } as unknown as WorkspaceModel;
}

/** One row's style cells, by header name — the numbers a screenshot cannot be checked against. */
function styleCells(company: string): { bench: string; delta: string } {
  const table = screen.getByRole("table");
  const heads = [...table.querySelectorAll("thead th")].map((th) =>
    th.textContent?.trim(),
  );
  const benchIndex = heads.indexOf("Style bench.");
  const deltaIndex = heads.indexOf("Change vs style");
  const body = table.querySelector("tbody");
  const tr = [...(body?.querySelectorAll("tr") ?? [])].find(
    (candidate) =>
      candidate.querySelector('th[scope="row"]')?.textContent?.trim() === company,
  );
  if (!tr) throw new Error(`no row for ${company}`);
  const cells = [...tr.querySelectorAll("td")];
  // `td` index is offset by the rank cell and by the row header being a `th`.
  return {
    bench: cells[benchIndex - 1]?.textContent?.trim() ?? "",
    delta: cells[deltaIndex - 1]?.textContent?.trim() ?? "",
  };
}

/** The company column's order, which is what a sort actually changes. */
function companyOrder(): string[] {
  const table = screen.getByRole("table");
  const body = table.querySelector("tbody");
  if (!body) return [];
  return [...body.querySelectorAll("tr")].map((tr) => {
    const header = tr.querySelector('th[scope="row"]');
    return header?.textContent?.trim() ?? "";
  });
}

describe("the style columns' sort", () => {
  it("renders both headers only when the gate passed and produced numbers", () => {
    render(<CompaniesLens model={model(true)} />);
    expect(screen.getByRole("button", { name: "Style bench." })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change vs style" })).toBeTruthy();
  });

  it("is absent — and drops a stale style sort back to weight — when the gate fails", () => {
    render(<CompaniesLens model={model(false)} />);
    expect(screen.queryByRole("button", { name: "Style bench." })).toBeNull();
    // Default sort is weight descending, and the caption says so rather than naming a
    // column that is not on the page.
    expect(screen.getByText(/Sorted by Your weight, largest first/)).toBeTruthy();
  });

  it("sorts by the style weight when that header is clicked", () => {
    render(<CompaniesLens model={model(true)} />);
    fireEvent.click(screen.getByRole("button", { name: "Style bench." }));

    // The blend is 60/40 (AVUV/AVDV), so from the fixture: c_def 0.6·0.133 + 0.4·0.067 =
    // 0.107, c_ghi 0.4·0.20 = 0.08, c_abc 0.6·0.10 = 0.06.
    expect(companyOrder()).toEqual(["C_DEF", "C_GHI", "C_ABC"]);
    // A second click reverses it: ascending, so the smallest style weight first.
    fireEvent.click(screen.getByRole("button", { name: "Style bench." }));
    expect(companyOrder()).toEqual(["C_ABC", "C_GHI", "C_DEF"]);
  });

  it("sorts by the difference, and the picker changes which benchmark that difference is against", () => {
    render(<CompaniesLens model={model(true)} />);
    fireEvent.click(screen.getByRole("button", { name: "Change vs style" }));

    // Against the blend: c_abc is held at 50% and carries 5% of it, so it is the most
    // overweight (0.45); then c_def (0.30 − 0.067 = 0.233); then c_ghi (0.20 − 0.10 = 0.10).
    expect(companyOrder()).toEqual(["C_ABC", "C_DEF", "C_GHI"]);
    expect(styleCells("C_GHI")).toEqual({ bench: "8.00%", delta: "(+12.00%)" });

    // Pick one class. US small value holds nothing of c_ghi and 10% of c_abc, so the style
    // numbers themselves move — which is the whole point of the picker.
    const picker = screen.getByRole("group", { name: /style benchmark/i });
    fireEvent.click(within(picker).getByRole("button", { name: "US Small Cap Value" }));
    // The caption is one line by design (static-xray-frontend v1.0.27); what the chosen
    // benchmark is *made of* lives in the composition list under the chips, which marks
    // the one the column is currently showing.
    const definitions = screen
      .getByText(/Benchmark composition/)
      .closest("[data-style-definitions]");
    expect(definitions?.textContent).toContain("US Small Cap Value — showing");
    expect(styleCells("C_GHI")).toEqual({ bench: "0.00%", delta: "(+20.00%)" });
    expect(styleCells("C_ABC")).toEqual({ bench: "10.00%", delta: "(+40.00%)" });
  });

  it("shows the blend by default and offers every class the gate selected", () => {
    render(<CompaniesLens model={model(true)} />);
    const picker = screen.getByRole("group", { name: /style benchmark/i });
    expect(
      within(picker).getByRole("button", { name: "Blend" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(picker).getByRole("button", { name: "US Small Cap Value" }),
    ).toBeTruthy();
    expect(
      within(picker).getByRole("button", { name: "Intl Small Cap Value" }),
    ).toBeTruthy();
    // Both classes' compositions are listed, not only the selected one: the reader has to
    // be able to check what "style" means without changing the column.
    const definitions = screen
      .getByText(/Benchmark composition/)
      .closest("[data-style-definitions]");
    const text = definitions?.textContent ?? "";
    expect(text).toContain("US Small Cap Value");
    expect(text).toContain("VBR · IJS · IWN");
    expect(text).toContain("Intl Small Cap Value");
    expect(text).toContain("AVDV · DISV · ISVL");
    expect(text).toContain("Equal-weighted");
    expect(text).toContain("filed 2026-09-30");
  });
});

describe("the style columns' defaults", () => {
  it("opens on your weight, and picking a style does not change the sort", () => {
    render(<CompaniesLens model={model(true)} />);
    expect(screen.getByText(/Sorted by Your weight, largest first/)).toBeTruthy();

    const picker = screen.getByRole("group", { name: /style benchmark/i });
    fireEvent.click(within(picker).getByRole("button", { name: "US Small Cap Value" }));
    // Choosing a benchmark re-bases the numbers; it is not a sort command.
    expect(screen.getByText(/Sorted by Your weight, largest first/)).toBeTruthy();
  });

  it("does not carry a style sort into a different portfolio", () => {
    const { rerender } = render(
      <CompaniesLens model={model(true, { AVUV: 0.6, AVDV: 0.4 })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Change vs style" }));
    expect(screen.getByText(/Sorted by Change vs style/)).toBeTruthy();

    // The reader replaces the funds. The table opens the way a first visit does.
    rerender(<CompaniesLens model={model(true, { SPMO: 1 })} />);
    expect(screen.getByText(/Sorted by Your weight, largest first/)).toBeTruthy();
  });

  it("names the benchmark's biggest names the reader does not hold, and says it is not advice", () => {
    // This book holds two of the three companies the benchmark carries, so c_ghi is the
    // (only) name it does not own.
    render(
      <CompaniesLens
        model={model(
          true,
          {},
          ledgerOf(ROWS.filter((row) => row.company_id !== "c_ghi")),
        )}
      />,
    );
    const summary = screen.getByText(/Style names you don.t own/i);
    const section = summary.closest("details");
    expect(section).not.toBeNull();
    const text = section?.textContent ?? "";
    // c_ghi is in the benchmark and at 0% of the portfolio; c_abc and c_def are held. The
    // name printed is the one the filings carry, which in this fixture is the id itself.
    expect(text).toMatch(/c_ghi/i);
    expect(text).not.toMatch(/c_abc/i);
    expect(text).toContain("not a suggestion");
    expect(text).toMatch(/held by/i);
  });
});
