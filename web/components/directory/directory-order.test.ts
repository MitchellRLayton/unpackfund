import { describe, expect, it } from "vitest";

import {
  ariaSortFor,
  defaultOrder,
  nextOrder,
  orderDescription,
  orderRows,
  orderValue,
  type Order,
} from "@/components/directory/directory-order";
import type { DirectoryRow } from "@/lib/directory";

function row(
  ticker: string,
  name: string,
  issuer: string,
  coverage = 99,
  netAssets: number | null = null,
): DirectoryRow {
  return { ticker, name, issuer, coverage, netAssets };
}

const rows: DirectoryRow[] = [
  row("VTI", "Vanguard Total Stock Market ETF", "Vanguard", 99.4, 400_000),
  row("BND", "Vanguard Total Bond Market ETF", "Vanguard", 45.2, 300_000),
  row("AVUV", "Avantis U.S. Small Cap Value ETF", "Avantis", 99.9, 9_000),
  row("AOR", "iShares Core Growth Allocation ETF", "iShares", 66.1, 2_000),
];

describe("defaultOrder", () => {
  it("opens on size when the release carries filed net assets", () => {
    expect(defaultOrder(rows)).toEqual({ kind: "assets" });
  });

  it("falls back to the editorial order when no row carries a figure", () => {
    const legacy = rows.map((entry) => ({ ...entry, netAssets: null }));
    expect(defaultOrder(legacy)).toEqual({ kind: "popular" });
  });
});

describe("orderRows", () => {
  it("leaves the ranker's order alone for a closest-match table", () => {
    const ranked = [...rows].reverse();
    expect(orderRows(ranked, { kind: "search" }).map((e) => e.ticker)).toEqual(
      ranked.map((e) => e.ticker),
    );
  });

  it("orders the fund-size column largest first, blanks last", () => {
    const legacy = [...rows, row("CASHX", "Money Market Fund", "Fidelity", 99, null)];
    expect(
      orderRows(legacy, { kind: "column", key: "assets", direction: "descending" }).map(
        (e) => e.ticker,
      ),
    ).toEqual(["VTI", "BND", "AVUV", "AOR", "CASHX"]);
    // Reversing the arrow must not move the fund with no figure to the top.
    expect(
      orderRows(legacy, { kind: "column", key: "assets", direction: "ascending" }).map(
        (e) => e.ticker,
      ),
    ).toEqual(["AOR", "AVUV", "BND", "VTI", "CASHX"]);
  });

  it("delegates the release orders to lib/directory", () => {
    expect(orderRows(rows, { kind: "assets" }).map((e) => e.ticker)).toEqual([
      "VTI",
      "BND",
      "AVUV",
      "AOR",
    ]);
    expect(orderRows(rows, { kind: "alpha" }).map((e) => e.ticker)).toEqual([
      "AOR",
      "AVUV",
      "BND",
      "VTI",
    ]);
  });

  it("sorts the printed columns ascending and descending", () => {
    const byName: Order = { kind: "column", key: "name", direction: "ascending" };
    expect(orderRows(rows, byName).map((e) => e.ticker)).toEqual([
      "AVUV",
      "AOR",
      "BND",
      "VTI",
    ]);

    const byCoverage: Order = {
      kind: "column",
      key: "coverage",
      direction: "descending",
    };
    expect(orderRows(rows, byCoverage).map((e) => e.coverage)).toEqual([
      99.9, 99.4, 66.1, 45.2,
    ]);
  });

  it("keeps ties on the ticker in the same order in both directions", () => {
    const tied = [
      row("ZZZ", "Same Name", "Issuer"),
      row("AAA", "Same Name", "Issuer"),
      row("MMM", "Same Name", "Issuer"),
    ];
    const ascending = orderRows(tied, {
      kind: "column",
      key: "name",
      direction: "ascending",
    });
    const descending = orderRows(tied, {
      kind: "column",
      key: "name",
      direction: "descending",
    });
    expect(ascending.map((e) => e.ticker)).toEqual(["AAA", "MMM", "ZZZ"]);
    expect(descending.map((e) => e.ticker)).toEqual(["AAA", "MMM", "ZZZ"]);
  });

  it("never mutates the input array", () => {
    const before = rows.map((entry) => entry.ticker);
    orderRows(rows, { kind: "column", key: "coverage", direction: "ascending" });
    expect(rows.map((entry) => entry.ticker)).toEqual(before);
  });
});

describe("nextOrder", () => {
  it("starts coverage on most-covered-first, fund size on largest-first", () => {
    expect(nextOrder({ kind: "assets" }, "assets")).toEqual({
      kind: "column",
      key: "assets",
      direction: "descending",
    });
    expect(nextOrder({ kind: "assets" }, "coverage")).toEqual({
      kind: "column",
      key: "coverage",
      direction: "descending",
    });
    expect(nextOrder({ kind: "assets" }, "name")).toEqual({
      kind: "column",
      key: "name",
      direction: "ascending",
    });
  });

  it("flips the direction when the same column is clicked again", () => {
    const first: Order = { kind: "column", key: "name", direction: "ascending" };
    expect(nextOrder(first, "name")).toEqual({
      kind: "column",
      key: "name",
      direction: "descending",
    });
    expect(nextOrder(nextOrder(first, "name"), "name")).toEqual(first);
  });

  it("starts a new column in its own direction", () => {
    const coverage: Order = {
      kind: "column",
      key: "coverage",
      direction: "descending",
    };
    expect(nextOrder(coverage, "issuer")).toEqual({
      kind: "column",
      key: "issuer",
      direction: "ascending",
    });
  });
});

describe("ariaSortFor", () => {
  it("marks no column when the table is in match order", () => {
    expect(ariaSortFor({ kind: "search" }, "name")).toBeUndefined();
  });

  it("marks only the sorted column", () => {
    const order: Order = {
      kind: "column",
      key: "coverage",
      direction: "ascending",
    };
    expect(ariaSortFor(order, "name")).toBeUndefined();
    expect(ariaSortFor(order, "coverage")).toBe("ascending");
    expect(ariaSortFor({ kind: "alpha" }, "ticker")).toBe("ascending");
    expect(ariaSortFor({ kind: "alpha" }, "name")).toBeUndefined();
    expect(ariaSortFor({ kind: "assets" }, "ticker")).toBeUndefined();
  });
});

describe("orderDescription", () => {
  it("says what the order means in words", () => {
    expect(orderDescription({ kind: "assets" })).toContain("filed N-PORT net assets");
    expect(orderDescription({ kind: "popular" })).toContain("not a size ranking");
    expect(orderDescription({ kind: "alpha" })).toBe("by ticker");
    expect(orderDescription({ kind: "search" })).toBe("closest match first");
    expect(
      orderDescription({ kind: "column", key: "assets", direction: "descending" }),
    ).toBe("by filed net assets, largest first");
    expect(
      orderDescription({ kind: "column", key: "coverage", direction: "descending" }),
    ).toBe("by coverage, most covered first");
    expect(
      orderDescription({ kind: "column", key: "name", direction: "ascending" }),
    ).toBe("by fund, ascending");
  });
});

describe("orderValue", () => {
  it("maps a column order to the select's placeholder value", () => {
    expect(orderValue({ kind: "assets" })).toBe("assets");
    expect(orderValue({ kind: "column", key: "name", direction: "ascending" })).toBe(
      "column",
    );
  });
});
