import { describe, expect, it } from "vitest";

import { isSplitEvenly, percentToBp, scaleToWhole, splitEvenly } from "./sides";

const fund = (ticker: string, weight_bp: number) => ({ ticker, weight_bp });

describe("percentToBp", () => {
  it("reads a typed percentage as basis points", () => {
    expect(percentToBp("12.5")).toBe(1250);
    expect(percentToBp("100")).toBe(10000);
    expect(percentToBp("0.01")).toBe(1);
    expect(percentToBp("33.333")).toBe(3333);
    expect(percentToBp(".5")).toBe(50);
    expect(percentToBp(" 60 ")).toBe(6000);
    expect(percentToBp("12.5%")).toBe(1250);
  });

  it("returns null for text it cannot read as a non-negative number", () => {
    expect(percentToBp("")).toBeNull();
    expect(percentToBp(".")).toBeNull();
    expect(percentToBp("abc")).toBeNull();
    expect(percentToBp("-5")).toBeNull();
    expect(percentToBp("1e3")).toBeNull();
    expect(percentToBp("5.5.5")).toBeNull();
  });
});

describe("splitEvenly", () => {
  it("distributes the remainder to the first rows and totals 10,000", () => {
    const split = splitEvenly([fund("A", 10000), fund("B", 0), fund("C", 0)]);
    expect(split).toEqual([fund("A", 3334), fund("B", 3333), fund("C", 3333)]);
    expect(split.reduce((sum, entry) => sum + entry.weight_bp, 0)).toBe(10000);
  });

  it("is the empty list for an empty side", () => {
    expect(splitEvenly([])).toEqual([]);
  });
});

describe("scaleToWhole", () => {
  it("keeps the proportions and reaches exactly 100%", () => {
    const scaled = scaleToWhole([fund("VOO", 6000), fund("VTI", 2800)]);
    expect(scaled).toEqual([fund("VOO", 6818), fund("VTI", 3182)]);
    expect(scaled.reduce((sum, entry) => sum + entry.weight_bp, 0)).toBe(10000);
  });

  it("scales a side that is over 100% down to it", () => {
    const scaled = scaleToWhole([fund("VOO", 15000), fund("VTI", 5000)]);
    expect(scaled).toEqual([fund("VOO", 7500), fund("VTI", 2500)]);
  });

  it("leaves a whole side unchanged", () => {
    expect(scaleToWhole([fund("VOO", 10000)])).toEqual([fund("VOO", 10000)]);
  });

  it("splits an all-zero side evenly, because there is no proportion to keep", () => {
    expect(scaleToWhole([fund("A", 0), fund("B", 0), fund("C", 0)])).toEqual([
      fund("A", 3334),
      fund("B", 3333),
      fund("C", 3333),
    ]);
  });

  it("always totals 10,000, whatever it is given", () => {
    const cases = [
      [fund("A", 1), fund("B", 2), fund("C", 3)],
      [fund("A", 9999), fund("B", 1)],
      [fund("A", 5000), fund("B", 3000), fund("C", 2001)],
      [fund("A", 7)],
    ];
    for (const funds of cases) {
      const total = scaleToWhole(funds).reduce((sum, entry) => sum + entry.weight_bp, 0);
      expect(total).toBe(10000);
    }
  });

  it("is the empty list for an empty side", () => {
    expect(scaleToWhole([])).toEqual([]);
  });
});

describe("isSplitEvenly", () => {
  it("recognises the app's own even split", () => {
    expect(isSplitEvenly([fund("A", 3334), fund("B", 3333), fund("C", 3333)])).toBe(true);
    expect(isSplitEvenly([fund("A", 5000), fund("B", 5000)])).toBe(true);
  });

  it("does not mistake a typed split or a short side for it", () => {
    expect(isSplitEvenly([fund("A", 6000), fund("B", 4000)])).toBe(false);
    expect(isSplitEvenly([fund("A", 5000), fund("B", 5000), fund("C", 0)])).toBe(false);
    expect(isSplitEvenly([])).toBe(false);
  });
});
