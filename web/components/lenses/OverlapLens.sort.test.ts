import { describe, expect, it } from "vitest";

import type { FundPairOverlap } from "./lens-math";
import { sortPairs } from "./OverlapLens";

function pair(a: string, b: string, overlap: number, shared: number) {
  const numbers: FundPairOverlap = {
    a,
    b,
    overlap,
    onlyA: 1 - overlap,
    onlyB: 1 - overlap,
    sharedCompanies: shared,
    unionCompanies: 100,
    resolvedA: 1,
    resolvedB: 1,
    weightA: 0.5,
    weightB: 0.5,
  };
  return { a, b, numbers };
}

const ROWS = [
  pair("AAA", "BBB", 0.1, 30),
  { a: "AAA", b: "ZZZ", numbers: null },
  pair("AAA", "CCC", 0.4, 5),
  pair("BBB", "CCC", 0.2, 90),
];

const order = (rows: { a: string; b: string }[]) =>
  rows.map((row) => `${row.a}-${row.b}`);

describe("sortPairs", () => {
  it("sorts by the chosen column, largest first", () => {
    expect(order(sortPairs(ROWS, { key: "overlap", direction: "descending" }))).toEqual([
      "AAA-CCC",
      "BBB-CCC",
      "AAA-BBB",
      "AAA-ZZZ",
    ]);
    expect(
      order(sortPairs(ROWS, { key: "sharedCompanies", direction: "descending" })),
    ).toEqual(["BBB-CCC", "AAA-BBB", "AAA-CCC", "AAA-ZZZ"]);
  });

  it("keeps a withheld pair last when the order is reversed", () => {
    expect(order(sortPairs(ROWS, { key: "overlap", direction: "ascending" }))).toEqual([
      "AAA-BBB",
      "BBB-CCC",
      "AAA-CCC",
      "AAA-ZZZ",
    ]);
  });
});
