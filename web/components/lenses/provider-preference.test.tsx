import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Ledger, LedgerRow, ReleaseDescriptor } from "@/lib/types";
import type { WorkspaceModel } from "@/lib/use-workspace";

import { MarketsLens } from "./MarketsLens";
import {
  parseProvider,
  providerFromSearch,
  providerSearch,
  resetProviderPreference,
} from "./provider-preference";
import { withEffective } from "../../lib/testing/ledger";

/**
 * The convention the Markets bar is drawn under.
 *
 * Two publishers disagree about a dozen domiciles, and Korea is the one a real portfolio
 * usually holds: emerging under MSCI, developed under FTSE Russell. So the tests here are
 * about the three things a reader can check — the URL says which convention is on screen,
 * the labels say it too, and the country that moves is explained rather than left to be
 * noticed.
 */

function row(company_id: string, country: string, weight: number): LedgerRow {
  return {
    company_id,
    name: `Company ${company_id}`,
    ticker: company_id.toUpperCase(),
    country,
    weight,
    benchmark_weight: null,
    holder_count: 1,
    held_directly: false,
    sources: [{ kind: "fund", ref: "AAA", weight }],
  };
}

/**
 * A whole portfolio, hand-worked: 60% the United States, 39% Switzerland, 1% Korea.
 *
 * Under MSCI that is 60.00 / 39.00 / 1.00. Under FTSE Russell Korea joins Switzerland in
 * developed ex-US, so it is 60.00 / 40.00 / 0.00 — one country, one point, and the only
 * row the disagreement table should list.
 */
function ledgerOf(korea: number | null): Ledger {
  const rows = [
    row("c_us", "US", 0.6),
    row("c_ch", "CH", korea === null ? 0.4 : 0.4 - korea),
    ...(korea === null ? [] : [row("c_kr", "KR", korea)]),
  ];
  return withEffective({
    rows,
    metrics: {
      hhi: 0.5,
      effective_n: 2,
      top10: 1,
      covered_weight_pct: 100,
      resolved_weight: 1,
      suppressed_weight: 0,
      invested_weight: 1,
      cash_weight: 0,
      unallocated_weight: 0,
    },
    benchmark: null,
    funds: [
      {
        ticker: "AAA",
        name: "AAA Fund",
        as_of: "2026-06-30",
        filed_at: "2026-08-28",
        lag_days: 59,
        coverage_pct: 100,
        source_url: "https://www.sec.gov/AAA",
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
  });
}

function model(ledger: Ledger): WorkspaceModel {
  const countries: Record<string, string> = { c_us: "US", c_ch: "CH", c_kr: "KR" };
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
    split: { fundWeights: { AAA: 1 }, direct: [], cash: 0, invested: 1, unallocated: 0 },
    funds: [],
    pendingFunds: [],
    fundsError: null,
    securities: { rows: new Map(), pending: [], error: null },
    countries,
    benchmark: null,
    ledger,
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
    fundByTicker: new Map(),
    countryOf: (companyId: string) => countries[companyId] ?? null,
    contested: {},
  } as unknown as WorkspaceModel;
}

/** The table that lists the countries the two conventions disagree about. */
function disagreementTable(container: HTMLElement): HTMLTableElement {
  const table = [...container.querySelectorAll("table")].find((node) =>
    node.querySelector("caption")?.textContent?.includes("Only the countries"),
  );
  if (!table) throw new Error("no disagreement table");
  return table;
}

function bodyRows(table: HTMLTableElement): HTMLTableRowElement[] {
  return [...table.querySelectorAll<HTMLTableRowElement>("tbody tr")];
}

beforeEach(() => {
  resetProviderPreference();
  window.history.replaceState(null, "", "/");
});

afterEach(cleanup);

describe("the provider in the query string", () => {
  it("reads a provider from ?cls=, case-insensitively, and nothing else", () => {
    expect(providerFromSearch("?cls=ftse")).toBe("FTSE");
    expect(providerFromSearch("?cls=FTSE")).toBe("FTSE");
    expect(providerFromSearch("?cls=msci")).toBe("MSCI");
    expect(providerFromSearch("?cls=nyse")).toBeNull();
    expect(providerFromSearch("")).toBeNull();
    expect(parseProvider(" msci ")).toBe("MSCI");
  });

  it("writes the default as nothing, so the default URL is unchanged", () => {
    expect(providerSearch("", "MSCI")).toBe("");
    expect(providerSearch("", "FTSE")).toBe("?cls=ftse");
    expect(providerSearch("?cls=ftse", "MSCI")).toBe("");
    // Another parameter is not this toggle's to drop.
    expect(providerSearch("?cls=ftse&ref=abc", "MSCI")).toBe("?ref=abc");
  });
});

describe("the Markets bar under a chosen convention", () => {
  it("defaults to MSCI, and says so on every label", () => {
    const { container } = render(<MarketsLens model={model(ledgerOf(0.01))} />);
    expect(
      screen.getByRole("button", { name: "MSCI" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "FTSE" }).getAttribute("aria-pressed"),
    ).toBe("false");
    // The legend and the table header both name the convention: never a bare "EM".
    expect(screen.getAllByText("Emerging Markets (MSCI)").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("Emerging Markets (FTSE)");
    expect(container.textContent).toContain("MSCI-aligned country classification");
  });

  it("reads ?cls=ftse and moves Korea into developed ex-US", () => {
    window.history.replaceState(null, "", "/?cls=ftse");
    const { container } = render(<MarketsLens model={model(ledgerOf(0.01))} />);
    expect(
      screen.getByRole("button", { name: "FTSE" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getAllByText("Emerging Markets (FTSE)").length).toBeGreaterThan(0);
    expect(container.textContent).toContain(
      "FTSE Russell-aligned country classification",
    );
    // 60.00 / 40.00 / 0.00: the point Korea carries leaves emerging for developed.
    expect(container.textContent).toContain("40.00%");
    expect(container.textContent).toContain("0.00%");
  });

  it("writes the choice to the query string, replacing the entry and keeping the fragment", () => {
    window.history.replaceState(null, "", "/x/#v2.abc");
    render(<MarketsLens model={model(ledgerOf(0.01))} />);
    fireEvent.click(screen.getByRole("button", { name: "FTSE" }));
    expect(window.location.search).toBe("?cls=ftse");
    // The portfolio is the fragment's, and a display preference never touches it.
    expect(window.location.hash).toBe("#v2.abc");
    fireEvent.click(screen.getByRole("button", { name: "MSCI" }));
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#v2.abc");
  });
});

describe("the country that moves", () => {
  it("explains Korea at one per cent of the bar, and offers the other convention", () => {
    const { container } = render(<MarketsLens model={model(ledgerOf(0.01))} />);
    expect(container.textContent).toContain(
      "is Emerging Markets under MSCI and International Developed ex-US under FTSE Russell",
    );
    // The button flips the toggle rather than telling the reader where it is.
    fireEvent.click(screen.getByRole("button", { name: "Show FTSE" }));
    expect(window.location.search).toBe("?cls=ftse");
    expect(container.textContent).toContain(
      "is International Developed ex-US under FTSE Russell and Emerging Markets under MSCI",
    );
  });

  it("stays quiet below one per cent, where the move is real but invisible", () => {
    const { container } = render(<MarketsLens model={model(ledgerOf(0.009))} />);
    expect(container.textContent).not.toContain("the two publishers disagree");
    // The row is still in the table: the threshold is about a sentence, not a fact.
    expect(bodyRows(disagreementTable(container))).toHaveLength(1);
  });

  it("lists only the countries whose segment changes", () => {
    const { container } = render(<MarketsLens model={model(ledgerOf(0.01))} />);
    const rows = bodyRows(disagreementTable(container));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("KR");
    expect(rows[0]?.textContent).toContain("Emerging Markets");
    expect(rows[0]?.textContent).toContain("International Developed ex-US");
    // The United States and Switzerland do not move, so they are not rows.
    expect(rows.map((node) => node.querySelector("th")?.textContent)).toEqual([
      "\u{1F1F0}\u{1F1F7} KR",
    ]);
  });

  it("says the two conventions agree when no country moves", () => {
    const { container } = render(<MarketsLens model={model(ledgerOf(null))} />);
    expect(container.textContent).toContain(
      "The two conventions agree for this portfolio: every country in it lands in the same segment under MSCI and FTSE Russell.",
    );
    expect(container.textContent).not.toContain("Only the countries");
  });
});
