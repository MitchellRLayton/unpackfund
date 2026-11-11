import { describe, expect, it } from "vitest";

import { equalWeights } from "@/lib/fragment";

import {
  EXAMPLE_ENTRIES,
  EXAMPLE_LABEL,
  EXAMPLE_TICKERS,
  isExamplePortfolio,
} from "./example";

/**
 * The example is content, so it is pinned: the label is the operator's exact sentence, and
 * the entries are a whole portfolio rather than a partial list. An example that did not
 * add up to 100% would teach the wrong shape on the one screen where a visitor has nothing
 * else to compare against, and hand-typed amounts would drift from the split the app
 * itself produces.
 */
describe("the worked example", () => {
  it("carries the exact label that keeps it from reading as a suggestion", () => {
    expect(EXAMPLE_LABEL).toBe("Example portfolio, not a recommendation.");
  });

  it("names each holding once, as a fund, in the order the example shows them", () => {
    const keys = EXAMPLE_ENTRIES.map((entry) => entry.key);
    expect(keys).toEqual(["QQQ", "VOO", "SMH", "VGT", "RSPT", "ARKK", "ALAI"]);
    expect(keys).toEqual(EXAMPLE_TICKERS);
    expect(new Set(keys).size).toBe(keys.length);
    expect(EXAMPLE_ENTRIES.every((entry) => entry.kind === "fund")).toBe(true);
  });

  it("is a whole percentage portfolio", () => {
    const total = EXAMPLE_ENTRIES.reduce((sum, entry) => sum + entry.amount, 0);
    expect(total).toBe(10_000);
  });

  it("is the app's own equal split, in integers one basis point apart", () => {
    // The hand-calculated expectation: 10,000 / 7 = 1,428 with a remainder of 4, which the
    // splitter gives to the first entries rather than dropping. Written out rather than
    // derived, so the test disagrees if `equalWeights` ever changes what "equal" means.
    expect(EXAMPLE_ENTRIES.map((entry) => entry.amount)).toEqual([
      1_429, 1_429, 1_429, 1_429, 1_428, 1_428, 1_428,
    ]);
    // And the same array the app itself would build for these tickers.
    expect(EXAMPLE_ENTRIES).toEqual(equalWeights(EXAMPLE_TICKERS));
  });
});

describe("isExamplePortfolio", () => {
  it("recognises the example the empty state loads", () => {
    expect(isExamplePortfolio("bp", EXAMPLE_ENTRIES)).toBe(true);
  });

  it("stops recognising it the moment an amount changes", () => {
    const changed = EXAMPLE_ENTRIES.map((entry, index) =>
      index === 0 ? { ...entry, amount: entry.amount + 1 } : entry,
    );
    expect(isExamplePortfolio("bp", changed)).toBe(false);
  });

  it("stops recognising it when the rows are reordered", () => {
    const reversed = [...EXAMPLE_ENTRIES].reverse();
    expect(isExamplePortfolio("bp", reversed)).toBe(false);
  });

  it("stops recognising it for a different seven funds at the same split", () => {
    const other = equalWeights(["VTI", "VXUS", "BND", "SCHD", "AVUV", "IJS", "IWN"]);
    expect(isExamplePortfolio("bp", other)).toBe(false);
  });

  it("stops recognising it in dollar mode, where the amounts mean something else", () => {
    expect(isExamplePortfolio("usd", EXAMPLE_ENTRIES)).toBe(false);
  });

  it("stops recognising it when a row is added or removed", () => {
    expect(isExamplePortfolio("bp", EXAMPLE_ENTRIES.slice(0, 6))).toBe(false);
    expect(
      isExamplePortfolio("bp", [
        ...EXAMPLE_ENTRIES,
        { kind: "fund", key: "SCHD", amount: 0 },
      ]),
    ).toBe(false);
  });
});
