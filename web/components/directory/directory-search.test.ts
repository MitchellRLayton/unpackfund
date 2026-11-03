import { describe, expect, it } from "vitest";

import {
  applyFilters,
  EMPTY_FILTERS,
  issuerOptions,
  matchesBand,
  searchRows,
} from "@/components/directory/directory-search";
import type { DirectoryRow } from "@/lib/directory";

function row(
  ticker: string,
  name: string,
  issuer: string,
  coverage = 99,
  netAssets: number | null = 1_000,
): DirectoryRow {
  return { ticker, name, issuer, coverage, netAssets };
}

// `X500` is deliberately first so that a test can tell the shared ranker's word
// rule apart from `filterRows`' arrival order.
const rows: DirectoryRow[] = [
  row("X500", "X500 Growth Fund", "Example Trust"),
  row("VOO", "Vanguard S&P 500 ETF", "Vanguard"),
  row("VTI", "Vanguard Total Stock Market ETF", "Vanguard", 99.4, 400_000),
  row("BND", "Vanguard Total Bond Market ETF", "Vanguard", 45.2, 300_000),
  row("AOR", "iShares Core Growth Allocation ETF", "iShares", 66.1, 2_000),
  row("AVUV", "Avantis U.S. Small Cap Value ETF", "Avantis", 99.9, 9_000),
  row("AVDV", "Avantis International Small Cap Value ETF", "Avantis", 98.1, 8_000),
];

describe("matchesBand", () => {
  it("uses the release's 70/60 gates, not its own", () => {
    expect(matchesBand(70, "full")).toBe(true);
    expect(matchesBand(69.9, "full")).toBe(false);
    expect(matchesBand(69.9, "partial")).toBe(true);
    expect(matchesBand(60, "partial")).toBe(true);
    expect(matchesBand(59.9, "none")).toBe(true);
    expect(matchesBand(59.9, "partial")).toBe(false);
  });

  it("admits every row for the unfiltered band", () => {
    expect(matchesBand(0, "all")).toBe(true);
    expect(matchesBand(100, "all")).toBe(true);
  });
});

describe("searchRows", () => {
  it("returns every row for an empty query, without reordering", () => {
    expect(searchRows(rows, "")).toEqual(rows);
    expect(searchRows(rows, "   ")).toEqual(rows);
  });

  it("puts an exact ticker first, whatever the case typed", () => {
    const found = searchRows(rows, "voo");
    expect(found[0]?.ticker).toBe("VOO");
  });

  it("ranks a name word that starts with the query above a name that contains it", () => {
    // `filterRows` returns both in arrival order (X500 first); the shared ranker
    // knows "500" is a word of VOO's name and a substring of X500's, and says so.
    const found = searchRows(rows, "500");
    expect(found.map((entry) => entry.ticker)).toEqual(["VOO", "X500"]);
  });

  it("ANDs the words of a multi-word query", () => {
    expect(searchRows(rows, "avantis small").map((e) => e.ticker)).toEqual([
      "AVUV",
      "AVDV",
    ]);
    expect(searchRows(rows, "avantis bond")).toEqual([]);
    expect(searchRows(rows, "vanguard bond").map((e) => e.ticker)).toEqual(["BND"]);
  });

  it("keeps every match when the ranker has no scoring rule for the query", () => {
    // `ETFs` singularises to the type word `ETF`, which `filterRows` matches against
    // the ticker and name; the ranker scores the literal string and finds nothing.
    // Dropping to its (empty) hit list would show "no funds" for a query that has
    // six, so the matched order is kept.
    const found = searchRows(rows, "ETFs");
    const narrowed = searchRows(rows, "ETF");
    expect(found.length).toBe(narrowed.length);
    expect(found.length).toBeGreaterThan(0);
  });

  it("never loses a row the filter matched", () => {
    for (const query of ["a", "v", "etf", "vanguard", "avantis etf"]) {
      expect(searchRows(rows, query).length).toBeGreaterThan(0);
    }
  });
});

describe("applyFilters", () => {
  const vanguard = rows.filter((entry) => entry.issuer === "Vanguard");

  it("narrows by issuer without changing the query", () => {
    const found = applyFilters(rows, { ...EMPTY_FILTERS, issuer: "Vanguard" });
    expect(found.map((entry) => entry.ticker).sort()).toEqual(["BND", "VOO", "VTI"]);
  });

  it("narrows by coverage band alone", () => {
    expect(
      applyFilters(rows, { ...EMPTY_FILTERS, band: "none" }).map((e) => e.ticker),
    ).toEqual(["BND"]);
    expect(
      applyFilters(rows, { ...EMPTY_FILTERS, band: "partial" }).map((e) => e.ticker),
    ).toEqual(["AOR"]);
    expect(applyFilters(rows, { ...EMPTY_FILTERS, band: "full" })).toHaveLength(5);
  });

  it("combines issuer, band and query", () => {
    const found = applyFilters(rows, {
      query: "bond",
      issuer: "Vanguard",
      band: "none",
    });
    expect(found.map((entry) => entry.ticker)).toEqual(["BND"]);
    expect(
      applyFilters(rows, { query: "bond", issuer: "Vanguard", band: "full" }),
    ).toEqual([]);
  });

  it("reports the empty set rather than everything when nothing matches", () => {
    expect(applyFilters(rows, { ...EMPTY_FILTERS, query: "zzzz" })).toEqual([]);
  });

  it("counts the issuer's funds the way the select shows them", () => {
    const options = issuerOptions(rows);
    expect(options.map((entry) => entry.issuer)).toEqual([
      "Avantis",
      "Example Trust",
      "iShares",
      "Vanguard",
    ]);
    expect(options.find((entry) => entry.issuer === "Vanguard")?.count).toBe(
      vanguard.length,
    );
  });
});
