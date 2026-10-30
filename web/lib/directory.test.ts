import { describe, expect, it } from "vitest";

import { filterRows, shownCoverage, toRows } from "./directory";

const funds: Record<string, [string, string, number, number]> = {
  AVUV: ["Avantis U.S. Small Cap Value ETF", "EA Series Trust", 1, 97.7],
  AVLV: ["Avantis U.S. Large Cap Value ETF", "EA Series Trust", 1, 99.7],
  VOO: ["VANGUARD 500 INDEX FUND", "VANGUARD INDEX FUNDS", 0, 99.1],
  AVDV: ["Avantis International Small Cap Value ETF", "EA Series Trust", 1, 12.8],
};

describe("toRows", () => {
  it("turns positional catalogue rows into named rows sorted by ticker", () => {
    const rows = toRows(funds);
    expect(rows.map((row) => row.ticker)).toEqual(["AVDV", "AVLV", "AVUV", "VOO"]);
    expect(rows.at(3)).toEqual({
      ticker: "VOO",
      name: "VANGUARD 500 INDEX FUND",
      issuer: "VANGUARD INDEX FUNDS",
      coverage: 99.1,
    });
  });
});

describe("filterRows", () => {
  const rows = toRows(funds);

  it("returns everything for an empty query", () => {
    expect(filterRows(rows, "   ")).toHaveLength(4);
  });

  it("puts an exact ticker ahead of everything that merely starts with it", () => {
    expect(filterRows(rows, "avlv").at(0)?.ticker).toBe("AVLV");
  });

  it("matches ticker prefixes, then names, then issuer substrings", () => {
    const prefixed = filterRows(rows, "AV");
    expect(prefixed).toHaveLength(3);
    // "EA Series Trust" is the issuer of all three, so ordering is by ticker here.
    expect(prefixed.map((row) => row.ticker)).toEqual(["AVDV", "AVLV", "AVUV"]);

    const byName = filterRows(rows, "500");
    expect(byName.map((row) => row.ticker)).toEqual(["VOO"]);

    const byIssuer = filterRows(rows, "vanguard");
    expect(byIssuer.map((row) => row.ticker)).toEqual(["VOO"]);
  });

  it("returns nothing rather than everything when nothing matches", () => {
    expect(filterRows(rows, "zzzz")).toEqual([]);
  });
});

describe("shownCoverage", () => {
  it("prints a figure at or above the partial band and withholds one below it", () => {
    expect(shownCoverage(60)).toBe("60.0%");
    expect(shownCoverage(99.7)).toBe("99.7%");
    expect(shownCoverage(12.8)).toBeNull();
  });
});
