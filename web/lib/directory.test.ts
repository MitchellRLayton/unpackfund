import { describe, expect, it } from "vitest";

import {
  DEFAULT_SORT,
  type DirectoryRow,
  filterRows,
  shownCoverage,
  sortRows,
  toRows,
} from "./directory";
import { POPULAR_ORDER, popularRank } from "./popular";

/**
 * A hand-written slice of the catalogue. The `etf` column is the release's name
 * heuristic (`name_rule_v1`) and is never consulted below — which is the point:
 * ALCEX is the real "Avantis U.S. Large Cap Value Fund", the heuristic labels it
 * an ETF, and searching "avantis etf" still has to exclude it because the words
 * decide, not the flag.
 *
 * The issuers here carry neither "etf" nor "fund", so those words can only come
 * from a fund's name. A real trust may be named for the word — Avantis funds sit
 * in "American Century ETF Trust" — which is why an issuer match is legal but
 * ranks below a name match; the last test in this file pins that.
 */
const funds: Record<string, [string, string, number, number]> = {
  AVUV: ["Avantis U.S. Small Cap Value ETF", "EA Series Trust", 1, 97.7],
  AVLV: ["Avantis U.S. Large Cap Value ETF", "EA Series Trust", 1, 99.7],
  VOO: ["VANGUARD 500 INDEX FUND", "VANGUARD INDEX FUNDS", 0, 99.1],
  AVDV: ["Avantis International Small Cap Value ETF", "EA Series Trust", 1, 12.8],
  ALCEX: ["Avantis U.S. Large Cap Value Fund", "EA Series Trust", 1, 99.1],
};

describe("toRows", () => {
  it("turns positional catalogue rows into named rows sorted by ticker", () => {
    const rows = toRows(funds);
    expect(rows.map((row) => row.ticker)).toEqual([
      "ALCEX",
      "AVDV",
      "AVLV",
      "AVUV",
      "VOO",
    ]);
    expect(rows.at(4)).toEqual({
      ticker: "VOO",
      name: "VANGUARD 500 INDEX FUND",
      issuer: "VANGUARD INDEX FUNDS",
      coverage: 99.1,
    });
  });
});

describe("filterRows", () => {
  const rows = toRows(funds);

  it("returns everything for an empty or whitespace query", () => {
    expect(filterRows(rows, "")).toHaveLength(5);
    expect(filterRows(rows, "   ")).toHaveLength(5);
  });

  it("puts an exact ticker ahead of everything that merely starts with it", () => {
    expect(filterRows(rows, "avlv").at(0)?.ticker).toBe("AVLV");
  });

  it("matches ticker prefixes, then names, then issuer substrings", () => {
    const prefixed = filterRows(rows, "AV");
    // Every Avantis name starts "Avantis", so all four are name-prefix matches and
    // the order is by ticker; ALCEX qualifies on its name, not its ticker.
    expect(prefixed.map((row) => row.ticker)).toEqual(["ALCEX", "AVDV", "AVLV", "AVUV"]);

    const byName = filterRows(rows, "500");
    expect(byName.map((row) => row.ticker)).toEqual(["VOO"]);

    const byIssuer = filterRows(rows, "vanguard");
    expect(byIssuer.map((row) => row.ticker)).toEqual(["VOO"]);
  });

  it("returns nothing rather than everything when nothing matches", () => {
    expect(filterRows(rows, "zzzz")).toEqual([]);
  });

  describe("several words are AND-ed", () => {
    it("finds an issuer's ETFs and its mutual fund with one word", () => {
      expect(filterRows(rows, "avantis").map((row) => row.ticker)).toEqual([
        "ALCEX",
        "AVDV",
        "AVLV",
        "AVUV",
      ]);
    });

    it("narrows to the ETFs when the second word is etf", () => {
      expect(filterRows(rows, "avantis etf").map((row) => row.ticker)).toEqual([
        "AVDV",
        "AVLV",
        "AVUV",
      ]);
    });

    it("narrows to the mutual fund when the second word is fund", () => {
      expect(filterRows(rows, "avantis fund").map((row) => row.ticker)).toEqual([
        "ALCEX",
      ]);
    });

    it("does not care about the order of the words", () => {
      expect(filterRows(rows, "etf avantis").map((row) => row.ticker)).toEqual(
        filterRows(rows, "avantis etf").map((row) => row.ticker),
      );
    });

    it("tolerates extra whitespace", () => {
      expect(filterRows(rows, "  avantis \t  fund  ").map((row) => row.ticker)).toEqual([
        "ALCEX",
      ]);
    });

    it("matches a word that appears only in the issuer", () => {
      // "trust" is in the issuer and in no fund name.
      expect(filterRows(rows, "avantis trust").map((row) => row.ticker)).toEqual([
        "ALCEX",
        "AVDV",
        "AVLV",
        "AVUV",
      ]);
      expect(filterRows(rows, "vanguard 500").map((row) => row.ticker)).toEqual(["VOO"]);
    });
  });
});

describe("filterRows multi-word ranking", () => {
  // Fabricated tickers, chosen so alphabetical order puts the weaker match first:
  // the assertion only holds if a name carrying every word is ranked ahead of a
  // row that carries one word in its issuer.
  const rows = toRows({
    AAEX: ["Global Equity ETF", "Avantis Investors", 0, 80],
    BBEX: ["Avantis Total World ETF", "EA Series Trust", 1, 80],
  });

  it("puts rows whose name carries every word ahead of the rest", () => {
    expect(filterRows(rows, "avantis etf").map((row) => row.ticker)).toEqual([
      "BBEX",
      "AAEX",
    ]);
  });
});

describe("filterRows issuer words and type words", () => {
  // The real shape of the Avantis family: the trust itself is "American Century
  // ETF Trust". An ordinary word in the issuer counts — but a *type* word must
  // not, or `avantis etf` answers with mutual funds and the reader is told
  // something false. On release 2026-10-30.5 that was 37 rows instead of 30.
  const rows = toRows({
    AVCNX: ["Avantis U.S. Small Cap Value Fund", "American Century ETF Trust", 1, 97.1],
    AVUV: ["Avantis U.S. Small Cap Value ETF", "American Century ETF Trust", 1, 97.7],
  });

  it("answers a type word from the fund's name only", () => {
    expect(filterRows(rows, "avantis etf").map((row) => row.ticker)).toEqual(["AVUV"]);
    expect(filterRows(rows, "avantis fund").map((row) => row.ticker)).toEqual(["AVCNX"]);
    expect(filterRows(rows, "avantis etfs").map((row) => row.ticker)).toEqual(["AVUV"]);
    expect(filterRows(rows, "avantis funds").map((row) => row.ticker)).toEqual(["AVCNX"]);
  });

  it("still answers an ordinary word from the issuer", () => {
    expect(filterRows(rows, "avantis century").map((row) => row.ticker)).toEqual([
      "AVCNX",
      "AVUV",
    ]);
  });
});

describe("sortRows", () => {
  const catalogue: Record<string, [string, string, number, number]> = {
    AAAA: ["Amplius Aggressive Asset Allocation ETF", "EA Series Trust", 1, 27.0],
    AAAAX: ["DWS RREEF Real Assets Fund", "DEUTSCHE DWS MARKET TRUST", 0, 49.0],
    VTI: ["VANGUARD TOTAL STOCK MARKET ETF", "VANGUARD INDEX FUNDS", 1, 90.0],
    AVUV: ["Avantis U.S. Small Cap Value ETF", "EA Series Trust", 1, 97.7],
  };
  const rows = toRows(catalogue);

  it("leads with the curated funds in curated order, then A–Z by ticker", () => {
    expect(sortRows(rows, "popular").map((row) => row.ticker)).toEqual([
      "VTI",
      "AVUV",
      "AAAA",
      "AAAAX",
    ]);
  });

  it("is the popular order by default", () => {
    expect(DEFAULT_SORT).toBe("popular");
    expect(sortRows(rows).map((row) => row.ticker)).toEqual(
      sortRows(rows, "popular").map((row) => row.ticker),
    );
  });

  it("switches to plain ticker order on request", () => {
    expect(sortRows(rows, "alpha").map((row) => row.ticker)).toEqual([
      "AAAA",
      "AAAAX",
      "AVUV",
      "VTI",
    ]);
  });

  it("never renders a curated ticker the catalogue does not publish", () => {
    // SPY is curated and absent from this slice: a sort reorders rows, it cannot
    // invent one.
    expect(POPULAR_ORDER).toContain("SPY");
    expect(sortRows(rows, "popular").map((row) => row.ticker)).not.toContain("SPY");
  });

  it("is deterministic whatever order it is handed", () => {
    const reversed: DirectoryRow[] = [...rows].reverse();
    expect(sortRows(reversed, "popular").map((row) => row.ticker)).toEqual(
      sortRows(rows, "popular").map((row) => row.ticker),
    );
  });
});

describe("popularRank", () => {
  it("ranks the curated list in its curated order", () => {
    expect(popularRank("VTI")).toBe(0);
    expect(popularRank("VOO")).toBe(1);
    expect(popularRank("FXAIX")).toBe(POPULAR_ORDER.length - 1);
  });

  it("is Infinity for a ticker the list does not name", () => {
    expect(popularRank("AAAA")).toBe(Infinity);
    expect(popularRank("ZZZZ")).toBe(Infinity);
  });

  it("names each ticker once", () => {
    expect(new Set(POPULAR_ORDER).size).toBe(POPULAR_ORDER.length);
  });

  it("keeps the operator's first picks and last pick", () => {
    expect(POPULAR_ORDER.slice(0, 5)).toEqual(["VTI", "VOO", "SPY", "IVV", "QQQ"]);
    expect(POPULAR_ORDER.at(-1)).toBe("FXAIX");
  });
});

describe("shownCoverage", () => {
  it("prints a figure at or above the partial band and withholds one below it", () => {
    expect(shownCoverage(60)).toBe("60.0%");
    expect(shownCoverage(99.7)).toBe("99.7%");
    expect(shownCoverage(12.8)).toBeNull();
  });
});
