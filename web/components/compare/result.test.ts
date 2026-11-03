import { describe, expect, it } from "vitest";

import { tallyOf } from "@/lib/holdings";
import type { LedgerRow } from "@/lib/types";
import type { OverlapRow } from "@/lib/overlap";

import {
  coverageGap,
  describePartial,
  describeUncomparable,
  joinWithAnd,
  marketSplit,
  mixTotals,
  onlyRows,
  sharedRows,
  sourceTickers,
} from "./result";

const row = (
  company_id: string,
  weightA: number,
  weightB: number,
  name = company_id,
): OverlapRow => ({
  company_id,
  name,
  ticker: null,
  weightA,
  weightB,
  delta: weightA - weightB,
  inBoth: weightA > 0 && weightB > 0,
});

const ledgerRow = (company_id: string, sources: LedgerRow["sources"]): LedgerRow => ({
  company_id,
  name: company_id,
  ticker: null,
  country: null,
  weight: 0.1,
  benchmark_weight: null,
  holder_count: sources.length,
  held_directly: false,
  sources,
});

describe("coverageGap", () => {
  it("splits funds at the 70 and 60 bands, not at invented thresholds", () => {
    const gap = coverageGap(
      [
        { ticker: "AAA", coverage_pct: 70 },
        { ticker: "BBB", coverage_pct: 69.9 },
        { ticker: "CCC", coverage_pct: 60 },
        { ticker: "DDD", coverage_pct: 59.9 },
        { ticker: "EEE", coverage_pct: 100 },
      ],
      [{ ticker: "BBB", coverage_pct: 69.9 }],
    );
    expect(gap.partial.map((fund) => fund.ticker)).toEqual(["CCC", "BBB"]);
    expect(gap.suppressed.map((fund) => fund.ticker)).toEqual(["DDD"]);
  });

  it("names a fund held by both sides once, with both sides recorded", () => {
    const gap = coverageGap(
      [{ ticker: "BBB", coverage_pct: 69.9 }],
      [{ ticker: "BBB", coverage_pct: 69.9 }],
    );
    expect(gap.partial).toHaveLength(1);
    expect(gap.partial[0]?.sides).toEqual(["a", "b"]);
  });

  it("is empty when every fund is fully traced", () => {
    const gap = coverageGap(
      [{ ticker: "AAA", coverage_pct: 100 }],
      [{ ticker: "BBB", coverage_pct: 93.2 }],
    );
    expect(gap).toEqual({ suppressed: [], partial: [] });
  });
});

describe("describeUncomparable", () => {
  it("names each fund, its side and its coverage, and states the floor", () => {
    expect(
      describeUncomparable([
        { ticker: "VTI", coveragePct: 52.1, sides: ["a"] },
        { ticker: "VXX", coveragePct: 44, sides: ["a", "b"] },
      ]),
    ).toBe(
      "VTI in Mix A (52.1% traced to companies) and VXX in both mixes (44.0% traced to companies) sit below the 60% coverage floor, so the share the two mixes hold in the same companies cannot be stated.",
    );
  });

  it("uses the singular when one fund is the reason", () => {
    expect(
      describeUncomparable([{ ticker: "VTI", coveragePct: 52.1, sides: ["b"] }]),
    ).toBe(
      "VTI in Mix B (52.1% traced to companies) sits below the 60% coverage floor, so the share the two mixes hold in the same companies cannot be stated.",
    );
  });
});

describe("describePartial", () => {
  it("says the share is a floor and names the funds", () => {
    const sentence = describePartial([
      { ticker: "VTI", coveragePct: 66.4, sides: ["a"] },
    ]);
    expect(
      sentence.startsWith("Partly traced: VTI in Mix A (66.4% traced to companies)."),
    ).toBe(true);
  });
});

describe("joinWithAnd", () => {
  it("reads as an English list", () => {
    expect(joinWithAnd([])).toBe("");
    expect(joinWithAnd(["A"])).toBe("A");
    expect(joinWithAnd(["A", "B"])).toBe("A and B");
    expect(joinWithAnd(["A", "B", "C"])).toBe("A, B and C");
  });
});

describe("mixTotals", () => {
  it("names the sides that are short of a whole", () => {
    expect(mixTotals([{ label: "Mix A", tally: tallyOf("bp", [8800]) }])).toBe(
      "Mix A totals 88.00%.",
    );
    expect(
      mixTotals([
        { label: "Mix A", tally: tallyOf("bp", [8800]) },
        { label: "Mix B", tally: tallyOf("bp", [9600]) },
      ]),
    ).toBe("Mix A totals 88.00% and Mix B totals 96.00%.");
  });
});

describe("marketSplit", () => {
  it("places US, developed, emerging, and leaves the rest unplaced", () => {
    const split = marketSplit(
      [
        { company_id: "c_0000000001", weight: 0.5 },
        { company_id: "c_0000000002", weight: 0.3 },
        { company_id: "c_0000000003", weight: 0.1 },
        { company_id: "c_0000000004", weight: 0.05 },
      ],
      {
        c_0000000001: "US",
        c_0000000002: "CH",
        c_0000000003: "TW",
        c_0000000004: "KY",
      },
    );
    expect(split.us).toBeCloseTo(0.5, 10);
    expect(split.dm).toBeCloseTo(0.3, 10);
    expect(split.em).toBeCloseTo(0.1, 10);
    // The Cayman holding and the 5% no company resolved for are one segment.
    expect(split.unplaced).toBeCloseTo(0.1, 10);
  });

  it("puts everything unplaced when no domiciles are known", () => {
    const split = marketSplit([{ company_id: "c_0000000001", weight: 0.6 }], null);
    expect(split).toEqual({ us: 0, dm: 0, em: 0, unplaced: 1 });
  });
});

describe("sharedRows and onlyRows", () => {
  const rows = [
    row("c_0000000004", 0.2, 0, "W"),
    row("c_0000000003", 0.2, 0.2, "Z"),
    row("c_0000000001", 0.5, 0.2, "X"),
    row("c_0000000005", 0, 0.2, "V"),
    row("c_0000000002", 0.1, 0.4, "Y"),
  ];

  it("partitions the rows between the three tabs", () => {
    const shared = sharedRows(rows);
    const a = onlyRows(rows, "a");
    const b = onlyRows(rows, "b");
    expect(shared.map((entry) => entry.name)).toEqual(["X", "Z", "Y"]);
    expect(a.map((entry) => entry.name)).toEqual(["W"]);
    expect(b.map((entry) => entry.name)).toEqual(["V"]);
    expect(shared.length + a.length + b.length).toBe(rows.length);
  });

  it("sorts each list by the weight it prints", () => {
    expect(
      sharedRows(rows).map((entry) => Math.min(entry.weightA, entry.weightB)),
    ).toEqual([0.2, 0.2, 0.1]);
    expect(onlyRows(rows, "a").map((entry) => entry.weightA)).toEqual([0.2]);
    expect(onlyRows(rows, "b").map((entry) => entry.weightB)).toEqual([0.2]);
  });
});

describe("sourceTickers", () => {
  it("lists the funds behind a company, largest contribution first", () => {
    const map = sourceTickers([
      ledgerRow("c_0000000001", [
        { kind: "fund", ref: "VTI", weight: 0.02 },
        { kind: "fund", ref: "VOO", weight: 0.06 },
      ]),
      ledgerRow("c_0000000002", [{ kind: "security", ref: "AMZN", weight: 0.1 }]),
    ]);
    expect(map.get("c_0000000001")).toEqual(["VOO", "VTI"]);
    // A directly held position is not a fund to look through, so there is no row.
    expect(map.has("c_0000000002")).toBe(false);
  });
});
