import { describe, expect, it } from "vitest";

import { EXAMPLE_ENTRIES, EXAMPLE_LABEL, isExamplePortfolio } from "./example";

/**
 * The example is content, so it is pinned: the label is the operator's exact sentence,
 * and the entries are a whole portfolio rather than a partial list. An example that did
 * not add up to 100% would teach the wrong shape on the one screen where a visitor has
 * nothing else to compare against.
 */
describe("the worked example", () => {
  it("carries the exact label that keeps it from reading as a suggestion", () => {
    expect(EXAMPLE_LABEL).toBe("Example portfolio, not a recommendation.");
  });

  it("is a whole percentage portfolio", () => {
    const total = EXAMPLE_ENTRIES.reduce((sum, entry) => sum + entry.amount, 0);
    expect(total).toBe(10_000);
  });

  it("names each holding once, as a fund", () => {
    const keys = EXAMPLE_ENTRIES.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(EXAMPLE_ENTRIES.every((entry) => entry.kind === "fund")).toBe(true);
  });
});

describe("isExamplePortfolio", () => {
  it("recognises the example the empty state loads", () => {
    expect(isExamplePortfolio("bp", EXAMPLE_ENTRIES)).toBe(true);
  });

  it("stops recognising it the moment an amount changes", () => {
    const changed = EXAMPLE_ENTRIES.map((entry) =>
      entry.key === "VTI" ? { ...entry, amount: 5_000 } : entry,
    );
    expect(isExamplePortfolio("bp", changed)).toBe(false);
  });

  it("stops recognising it in dollar mode, where the amounts mean something else", () => {
    expect(isExamplePortfolio("usd", EXAMPLE_ENTRIES)).toBe(false);
  });

  it("stops recognising it when a row is added or removed", () => {
    expect(isExamplePortfolio("bp", EXAMPLE_ENTRIES.slice(0, 2))).toBe(false);
    expect(
      isExamplePortfolio("bp", [
        ...EXAMPLE_ENTRIES,
        { kind: "fund", key: "SCHD", amount: 0 },
      ]),
    ).toBe(false);
  });
});
