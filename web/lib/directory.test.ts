import { describe, expect, it } from "vitest";

import {
  type CatalogueTuple,
  DEFAULT_SORT,
  defaultSort,
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
    // Names and issuers are display text: a filing's all-caps string is title-cased,
    // and the mixed-case Avantis strings come through as authored.
    expect(rows.at(4)).toEqual({
      ticker: "VOO",
      name: "Vanguard 500 Index Fund",
      issuer: "Vanguard Index Funds",
      coverage: 99.1,
      netAssets: null,
    });
  });

  it("reads the filed net assets from a five-element row", () => {
    const rows = toRows({
      // The real Avantis string: mixed case, so `displayName` leaves it whole.
      AVUV: [
        "Avantis U.S. Small Cap Value ETF",
        "EA Series Trust",
        1,
        97.7,
        34_500_000_000,
      ],
      AAAX: ["A Fund With No Filed Size", "SOME TRUST", 0, 40.0, null],
    });
    expect(rows.map((row) => row.ticker)).toEqual(["AAAX", "AVUV"]);
    expect(rows[0]?.netAssets).toBeNull();
    expect(rows[1]?.netAssets).toBe(34_500_000_000);
    expect(rows[1]?.issuer).toBe("EA Series Trust");
  });

  it("treats a four-element row as no size, not as zero", () => {
    // The live release 2026-11-02.7 was built before the fifth element existed, so
    // the reader must see "no figure" rather than a fund that owns nothing.
    const rows = toRows({
      VOO: ["VANGUARD 500 INDEX FUND", "VANGUARD INDEX FUNDS", 0, 99.1],
    });
    expect(rows[0]?.netAssets).toBeNull();
    expect(rows[0]?.name).toBe("Vanguard 500 Index Fund");
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
  // The figures are arranged so the three orders disagree, which is the point: a
  // default that is actually applied cannot be confused with the ticker order it
  // replaced, and the curated order is a third answer again.
  const catalogue: Record<string, CatalogueTuple> = {
    AAAA: [
      "Amplius Aggressive Asset Allocation ETF",
      "EA Series Trust",
      1,
      27.0,
      1_000_000_000,
    ],
    AAAAX: [
      "DWS RREEF Real Assets Fund",
      "DEUTSCHE DWS MARKET TRUST",
      0,
      49.0,
      25_000_000_000,
    ],
    VTI: [
      "VANGUARD TOTAL STOCK MARKET ETF",
      "VANGUARD INDEX FUNDS",
      1,
      90.0,
      400_000_000_000,
    ],
    AVUV: [
      "Avantis U.S. Small Cap Value ETF",
      "EA Series Trust",
      1,
      97.7,
      30_000_000_000,
    ],
  };
  const rows = toRows(catalogue);

  it("leads with the largest filed assets", () => {
    expect(sortRows(rows, "assets").map((row) => row.ticker)).toEqual([
      "VTI",
      "AVUV",
      "AAAAX",
      "AAAA",
    ]);
  });

  it("puts funds without a figure after the funds that have one, in ticker order", () => {
    // A missing figure is not a small one: zero would sort it beside a genuinely
    // empty fund, so it goes after every known answer.
    const mixed = toRows({
      AAAA: ["Amplius Aggressive Asset Allocation ETF", "EA Series Trust", 1, 27.0, null],
      AAAAX: ["DWS RREEF Real Assets Fund", "DEUTSCHE DWS MARKET TRUST", 0, 49.0],
      VTI: [
        "VANGUARD TOTAL STOCK MARKET ETF",
        "VANGUARD INDEX FUNDS",
        1,
        90.0,
        400_000_000_000,
      ],
      AVUV: [
        "Avantis U.S. Small Cap Value ETF",
        "EA Series Trust",
        1,
        97.7,
        30_000_000_000,
      ],
    });
    expect(sortRows(mixed, "assets").map((row) => row.ticker)).toEqual([
      "VTI",
      "AVUV",
      "AAAA",
      "AAAAX",
    ]);
  });

  it("breaks an equal-assets tie by ticker", () => {
    const tied = toRows({
      ZZZZ: ["A Fund", "A Trust", 1, 50.0, 5_000_000_000],
      AAAA: ["Another Fund", "A Trust", 1, 50.0, 5_000_000_000],
    });
    expect(sortRows(tied, "assets").map((row) => row.ticker)).toEqual(["AAAA", "ZZZZ"]);
  });

  it("opens on assets by default when the release carries figures", () => {
    expect(DEFAULT_SORT).toBe("assets");
    expect(defaultSort(rows)).toBe("assets");
    expect(sortRows(rows).map((row) => row.ticker)).toEqual(
      sortRows(rows, "assets").map((row) => row.ticker),
    );
  });

  it("falls back to the editorial order when the release carries no figures", () => {
    // Live release 2026-11-02.7: four-element catalogue rows, so every `netAssets`
    // is null and a size order would silently be ticker order. The page has to keep
    // the order it shipped with and say why instead of claiming a ranking.
    const assetless = toRows({
      AAAA: ["Amplius Aggressive Asset Allocation ETF", "EA Series Trust", 1, 27.0],
      AAAAX: ["DWS RREEF Real Assets Fund", "DEUTSCHE DWS MARKET TRUST", 0, 49.0],
      VTI: ["VANGUARD TOTAL STOCK MARKET ETF", "VANGUARD INDEX FUNDS", 1, 90.0],
      AVUV: ["Avantis U.S. Small Cap Value ETF", "EA Series Trust", 1, 97.7],
    });
    expect(defaultSort(assetless)).toBe("popular");
    expect(sortRows(assetless).map((row) => row.ticker)).toEqual([
      "VTI",
      "AVUV",
      "AAAA",
      "AAAAX",
    ]);
    expect(sortRows(assetless)).toEqual(sortRows(assetless, "popular"));
  });

  it("leads with the curated funds in curated order, then A–Z by ticker", () => {
    expect(sortRows(rows, "popular").map((row) => row.ticker)).toEqual([
      "VTI",
      "AVUV",
      "AAAA",
      "AAAAX",
    ]);
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
    expect(sortRows(reversed, "assets").map((row) => row.ticker)).toEqual(
      sortRows(rows, "assets").map((row) => row.ticker),
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
