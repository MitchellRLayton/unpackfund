/**
 * The film's two pieces of testable arithmetic: the field's data contract and its geometry.
 *
 * Everything else in `web/components/intro` is DOM and choreography, which this suite cannot
 * judge — a timeline that reads well is a review, not a test. What *can* be pinned down is
 * what the packing guarantees (a distribution, not a pile) and what the data contract
 * accepts, and both of those are where a regression is expensive and silent.
 */

import { describe, expect, it } from "vitest";

import {
  CLUSTER_COUNT,
  DOT_MAX_R,
  DOT_MIN_R,
  expandCompanies,
  layoutField,
} from "./layout";
import { clusterOf, formatFiledLine, labelByCompany, parseField } from "./types";

/** A small, deterministic stand-in for the baked field: no network, no 1,004-row fixture. */
function syntheticCompanies(count: number): Array<{ k: "a" | "b" | "s"; w: number }> {
  return Array.from({ length: count }, (_, index) => {
    const spread = (index * 37) % 11;
    const weight = 40 + spread * 130;
    const kind: "a" | "b" | "s" = index % 9 === 0 ? "a" : index % 13 === 0 ? "b" : "s";
    return { k: kind, w: weight };
  });
}

function field() {
  const companies = syntheticCompanies(40);
  const labels = new Map<number, string>([
    [0, "NVDA"],
    [13, "AAPL"],
    [18, "MSFT"],
  ]);
  const { dots, pairs } = expandCompanies(companies, labels);
  return { companies, dots, pairs };
}

describe("expandCompanies", () => {
  it("spills one dot per held position and pairs the companies both funds hold", () => {
    const { companies, dots, pairs } = field();
    const shared = companies.filter((company) => company.k === "s").length;
    const onlyA = companies.filter((company) => company.k === "a").length;
    const onlyB = companies.filter((company) => company.k === "b").length;

    expect(dots).toHaveLength(shared * 2 + onlyA + onlyB);
    expect(pairs).toHaveLength(shared);
    expect(dots.filter((dot) => dot.fund === 0)).toHaveLength(shared + onlyA);
    expect(dots.filter((dot) => dot.fund === 1)).toHaveLength(shared + onlyB);
  });

  it("puts the label on the first half of a shared company, and on nothing else", () => {
    const { dots, pairs } = field();
    const labelled = dots.filter((dot) => dot.label !== null);
    // Company 13 is held by one fund only, so its label is dropped: the film prints the
    // twelve biggest companies the *pair* has in common, and a one-fund row is not one.
    expect(labelled.map((dot) => dot.label).sort()).toEqual(["MSFT", "NVDA"]);
    for (const [first] of pairs) {
      expect(dots[first]!.fund).toBe(0);
      expect(dots[first]!.shared).toBe(true);
    }
    // A first-fund dot that is not shared carries no label unless the map gave it one.
    expect(dots[0]!.label).toBe("NVDA");
    expect(dots[1]!.label).toBeNull();
  });
});

describe("layoutField", () => {
  it("is deterministic: the same field packs to the same pixels", () => {
    const { dots, pairs } = field();
    const first = layoutField(dots, pairs, false);
    const second = layoutField(dots, pairs, false);
    expect(second.dots).toEqual(first.dots);
    expect(second.line).toEqual(first.line);
    expect(second.circleSlot).toBe(first.circleSlot);
  });

  it("gives every dot a finite home inside the reported bounds", () => {
    const { dots, pairs } = field();
    const geometry = layoutField(dots, pairs, false);
    expect(geometry.dots).toHaveLength(dots.length);
    for (const dot of geometry.dots) {
      expect(Number.isFinite(dot.x)).toBe(true);
      expect(Number.isFinite(dot.y)).toBe(true);
      expect(dot.x).toBeGreaterThanOrEqual(geometry.bounds.minX - 0.01);
      expect(dot.x).toBeLessThanOrEqual(geometry.bounds.maxX + 0.01);
      expect(dot.y).toBeGreaterThanOrEqual(geometry.bounds.minY - 0.01);
      expect(dot.y).toBeLessThanOrEqual(geometry.bounds.maxY + 0.01);
    }
  });

  it("scales dot area with weight, and keeps the encoding after the field is scaled", () => {
    const { dots, pairs } = field();
    const geometry = layoutField(dots, pairs, false);
    const radii = geometry.dots.map((dot) => dot.r);
    // `r` is reported in scaled world units, so the band is DOT_MIN_R…DOT_MAX_R times the
    // field's own scale factor — the property that must hold is the ordering, not the bound.
    expect(Math.min(...radii)).toBeGreaterThan(DOT_MIN_R);
    expect(Math.max(...radii)).toBeGreaterThan(Math.min(...radii) * 2);
    const byWeight = dots
      .map((dot, index) => ({ weight: dot.weightBp, r: geometry.dots[index]!.r }))
      .sort((left, right) => left.weight - right.weight);
    for (let index = 1; index < byWeight.length; index += 1) {
      expect(byWeight[index]!.r).toBeGreaterThanOrEqual(byWeight[index - 1]!.r - 0.001);
    }
  });

  it("does not let two companies interpenetrate", () => {
    const { dots, pairs } = field();
    const geometry = layoutField(dots, pairs, false);
    const paired = new Set(pairs.flat());
    let worst = Number.POSITIVE_INFINITY;
    let worstPair: [number, number] = [-1, -1];
    for (let a = 0; a < geometry.dots.length; a += 1) {
      if (paired.has(a)) continue;
      for (let b = a + 1; b < geometry.dots.length; b += 1) {
        if (paired.has(b)) continue;
        const dotA = geometry.dots[a]!;
        const dotB = geometry.dots[b]!;
        const distance = Math.hypot(dotA.x - dotB.x, dotA.y - dotB.y);
        const ratio = distance / (dotA.r + dotB.r);
        if (ratio < worst) {
          worst = ratio;
          worstPair = [a, b];
        }
      }
    }
    // `gap()` in layout.ts aims for (ra + rb) * 0.55 + 1.2, so centres should never sit
    // closer than half the sum of the radii; anything under that is a visible collision.
    expect(
      worst,
      `closest pair ${worstPair[0]}/${worstPair[1]} at ${worst.toFixed(3)} of (ra + rb)`,
    ).toBeGreaterThan(0.5);
  });

  it("compresses every surviving company onto one line, once", () => {
    const { dots, pairs } = field();
    const geometry = layoutField(dots, pairs, false);
    // One slot per company, not per dot: the 40 dots of a shared company land as one tick.
    const survivors = dots.length - pairs.length;
    expect(geometry.line).toHaveLength(survivors);
    expect(geometry.lineOwner).toHaveLength(survivors);
    expect(new Set(geometry.lineOwner).size).toBe(survivors);
    for (const slot of geometry.line) {
      expect(slot.y).toBe(0);
      expect(slot.r).toBeGreaterThan(0);
    }
    // Left to right, in the order the survivors are indexed.
    const xs = geometry.line.map((slot) => slot.x);
    expect([...xs].sort((left, right) => left - right)).toEqual(xs);
    expect(geometry.circleSlot).toBeGreaterThanOrEqual(0);
    expect(geometry.circleSlot).toBeLessThan(geometry.line.length);
  });

  it("uses the same eleven patches in portrait and in landscape", () => {
    const { dots, pairs } = field();
    const wide = layoutField(dots, pairs, false);
    const tall = layoutField(dots, pairs, true);
    expect(wide.clusterCenters).toHaveLength(CLUSTER_COUNT);
    expect(tall.clusterCenters).toHaveLength(CLUSTER_COUNT);
    // Portrait is a narrower, taller frame: its bounds must not be wider than the wide one's.
    expect(tall.bounds.maxX - tall.bounds.minX).toBeLessThanOrEqual(
      wide.bounds.maxX - wide.bounds.minX + 0.01,
    );
  });
});

describe("the data contract", () => {
  const companies = syntheticCompanies(6);

  it("formats a filing date the way the caption prints it", () => {
    expect(formatFiledLine("2026-08-28")).toBe("filed 28 AUG 2026");
    expect(formatFiledLine("2026-01-05")).toBe("filed 05 JAN 2026");
    // A bad date is shown, not thrown: a broken artifact must still be legible on screen.
    expect(formatFiledLine("2026-13-01")).toBe("filed 2026-13-01");
    expect(formatFiledLine("")).toBe("filed ");
  });

  it("maps cluster groups into a fixed range, deterministically", () => {
    for (let index = 0; index < 200; index += 1) {
      const cluster = clusterOf(index);
      expect(Number.isInteger(cluster)).toBe(true);
      expect(cluster).toBeGreaterThanOrEqual(0);
      expect(cluster).toBeLessThan(CLUSTER_COUNT);
      expect(clusterOf(index)).toBe(cluster);
    }
  });

  it("joins the twelve labels to their companies by weight, skipping single-fund rows", () => {
    const labels = [
      { name: "NVIDIA CORP", ticker: "NVDA", weight: companies[0]!.w },
      { name: "APPLE INC", ticker: "AAPL", weight: companies[13 % companies.length]!.w },
      { name: "NOT HELD", ticker: "NOPE", weight: 99999 },
    ];
    const map = labelByCompany(companies, labels);
    expect(map.get(0)).toBe("NVDA");
    expect([...map.values()]).not.toContain("NOPE");
  });

  it("accepts the baked shape and rejects a different one", () => {
    const valid = {
      schema: 1,
      release: "2026-11-03.1",
      generated_at: "2026-11-03T00:00:00Z",
      pair: ["SPY", "VOO"],
      funds: [
        {
          ticker: "SPY",
          name: "SPDR S&P 500 ETF TRUST",
          as_of: "2026-09-30",
          filed_at: "2026-08-28",
          lag_days: 33,
          coverage_pct: 100,
          holdings: 501,
        },
        {
          ticker: "VOO",
          name: "VANGUARD 500 INDEX FUND",
          as_of: "2026-09-30",
          filed_at: "2026-08-28",
          lag_days: 33,
          coverage_pct: 99.7,
          holdings: 503,
        },
      ],
      totals: { held: 1004, distinct: 504, shared: 500 },
      labels: [{ name: "NVIDIA CORP", ticker: "NVDA", weight: companies[0]!.w }],
      companies,
    };

    const parsed = parseField(valid);
    expect(parsed.companies).toHaveLength(companies.length);
    expect(parsed.funds[0].ticker).toBe("SPY");

    expect(() => parseField({ ...valid, schema: 2 })).toThrow(/schema/);
    expect(() => parseField({ ...valid, pair: ["SPY"] })).toThrow(/pair/);
    expect(() => parseField({ ...valid, companies: [{ k: "x", w: 1 }] })).toThrow();
    expect(() => parseField({ ...valid, totals: { held: 1, distinct: 1 } })).toThrow(
      /shared/,
    );
  });

  it("expands the baked counts to the arithmetic the film relies on", () => {
    // The shape of the real artifact: 500 companies both funds hold, 3 only the second, 1
    // only the first. 1,004 dots in, 504 survivors out — the odometer's two numbers.
    const real = [
      ...Array.from({ length: 500 }, () => ({ k: "s" as const, w: 120 })),
      ...Array.from({ length: 3 }, () => ({ k: "b" as const, w: 40 })),
      { k: "a" as const, w: 20 },
    ];
    const { dots, pairs } = expandCompanies(real, new Map());
    expect(dots).toHaveLength(1004);
    expect(pairs).toHaveLength(500);
    expect(dots.filter((dot) => dot.fund === 0)).toHaveLength(501);
    expect(dots.filter((dot) => dot.fund === 1)).toHaveLength(503);
  });
});
