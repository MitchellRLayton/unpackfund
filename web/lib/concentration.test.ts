import { describe, expect, it } from "vitest";

import {
  cumulativeCurve,
  curveAriaLabel,
  equalWeightCurve,
  invertRank,
  k50,
  logGrid,
  pngFooter,
  resample,
  summarySentence,
  topShare,
  type WeightedCompany,
} from "./concentration";

/**
 * The curve's maths, on the prompt's own cases.
 *
 * The chart is a drawing of these numbers, so the tests are the hand-checked answers a
 * reader can do on paper: 50/50 is 2, 90/10 is about 1.22, four equal weights cross half
 * at the second, and the grid is the same for every portfolio so the two series can be
 * compared point for point.
 */

const w = (name: string, weight: number): WeightedCompany => ({
  name,
  ticker: null,
  weight,
});

describe("the cumulative curve", () => {
  it("is [0.5, 1] for 50/50, and half the money is in the first company", () => {
    const curve = cumulativeCurve([w("A", 0.5), w("B", 0.5)]);
    expect(curve).toEqual([0.5, 1]);
    expect(k50(curve)).toBe(1);
  });

  it("is [0.25, 0.5, 0.75, 1] for four equal weights, crossing half at the second", () => {
    const curve = cumulativeCurve([
      w("A", 0.25),
      w("B", 0.25),
      w("C", 0.25),
      w("D", 0.25),
    ]);
    expect(curve).toEqual([0.25, 0.5, 0.75, 1]);
    expect(k50(curve)).toBe(2);
  });

  it("sorts descending and breaks ties by name", () => {
    const curve = cumulativeCurve([w("B", 0.1), w("A", 0.6), w("C", 0.3)]);
    expect(curve[0]).toBeCloseTo(0.6, 12);
    expect(curve[1]).toBeCloseTo(0.9, 12);
    expect(curve[2]).toBe(1);
    // Equal weights: the name decides the order, so the output is stable.
    expect(cumulativeCurve([w("B", 0.5), w("A", 0.5)])).toEqual([0.5, 1]);
  });

  it("gives the same curve for weights summing to 0.983 as for normalised weights", () => {
    const raw = cumulativeCurve([w("A", 0.5 * 0.983), w("B", 0.483 * 0.983)]);
    const normalised = cumulativeCurve([w("A", 0.5), w("B", 0.483)]);
    expect(raw).toEqual(normalised);
  });
});

describe("the shared grid", () => {
  it("has every rank 1–100, is strictly increasing, ends at maxN and stays under 260 points", () => {
    const grid = logGrid(9800);
    for (let rank = 1; rank <= 100; rank += 1) expect(grid).toContain(rank);
    expect(
      grid.every((value, index) => index === 0 || value > (grid[index - 1] ?? 0)),
    ).toBe(true);
    expect(grid[grid.length - 1]).toBe(9800);
    expect(grid.length).toBeLessThanOrEqual(260);
  });

  it("resamples beyond N to 1 and stays monotone", () => {
    const points = resample([0.5, 1], [1, 2, 3, 10]);
    expect(points).toEqual([
      [1, 0.5],
      [2, 1],
      [3, 1],
      [10, 1],
    ]);
    expect(
      points.every(
        (point, index) => index === 0 || point[1] >= (points[index - 1]?.[1] ?? 0),
      ),
    ).toBe(true);
  });
});

describe("the pointer's rank", () => {
  it("clamps to [1, maxN] and returns integers", () => {
    expect(invertRank(-50, 48, 500, 9800)).toBe(1);
    expect(invertRank(9999, 48, 500, 9800)).toBe(9800);
    expect(Number.isInteger(invertRank(300, 48, 500, 9800))).toBe(true);
  });
});

describe("the top share", () => {
  it("is the whole portfolio when there are fewer than ten companies", () => {
    expect(topShare([0.5, 1], 10)).toBe(1);
  });
});

describe("the words", () => {
  it("names both halves of the summary, and only the You half without a benchmark", () => {
    expect(summarySentence(19, { ticker: "VT", k50: 118 })).toBe(
      "Half your money is in your top 19 companies. For VT, it's the top 118.",
    );
    expect(summarySentence(19, null)).toBe(
      "Half your money is in your top 19 companies.",
    );
  });

  it("puts the top-ten shares in the accessible name", () => {
    expect(
      curveAriaLabel("Half your money is in your top 19 companies.", 0.374, {
        ticker: "VT",
        top10: 0.227,
      }),
    ).toBe(
      "Half your money is in your top 19 companies. Your top 10 companies are 37.4% of your money; for VT, 22.7%.",
    );
  });
});

describe("the equal-weight reference curves", () => {
  it("reaches 100% exactly at rank N and stays flat afterwards", () => {
    const grid = logGrid(100);
    const points = equalWeightCurve(30, grid);
    expect(points[29]).toEqual([30, 1]);
    expect(points.filter(([rank]) => rank > 30).every(([, value]) => value === 1)).toBe(
      true,
    );
    // Before the elbow the line is k/N: rank 15 is half the money.
    expect(points[14]).toEqual([15, 0.5]);
  });
});

describe("the download footer", () => {
  it("keeps the band and the effective count in the image", () => {
    expect(pngFooter("Moderate", 45.309)).toBe(
      "Moderate · 45 effective holdings · unpackfund.com · Source: SEC EDGAR",
    );
    expect(pngFooter("Very concentrated", 1.2)).toBe(
      "Very concentrated · 1.2 effective holdings · unpackfund.com · Source: SEC EDGAR",
    );
  });
});
