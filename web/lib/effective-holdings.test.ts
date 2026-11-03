/**
 * The acceptance fixtures for effective holdings.
 *
 * These are the operator's own table, value for value. They are the reason the module
 * exists in the shape it does, and each one pins a rule that a plausible simplification
 * would break:
 *
 * - **5 is the merge test.** 50% of a fund that holds X and Y, plus 50% of X directly.
 *   Squaring or logging each *source's* weight before merging gives the disjoint answer
 *   for the headline pair, and that is the bug this fixture exists to catch: X is 0.8 of
 *   the money and Y is 0.2, whatever route either arrived by.
 * - **7 is the denominator test.** Cash is outside `T`, so 80% of a fund reads exactly
 *   as 100% of it. A metric computed over NAV would move by a fifth here.
 * - **8 is the coverage test.** Unmatched weight stays out of the shares and in `Q`, so
 *   the pair describes the 80% we can see while the range describes the whole portfolio.
 * - **9 and 10 are the gap case**: the same headline, a long tail, and a Broad far above
 *   Core — the shape a single number cannot describe.
 * - **2 is the identity**: equal weights put Core, Broad and N on the same point, which
 *   is the only case where they coincide.
 */

import { describe, expect, it } from "vitest";

import { effectiveHoldings, type EffectiveInput } from "./effective-holdings";

/** A company whose weight came from the listed sources, in the order given. */
function company(weight: number, ...sources: number[]) {
  return { weight, sources: sources.map((source) => ({ weight: source })) };
}

function holdings(input: Partial<EffectiveInput> & Pick<EffectiveInput, "companies">) {
  return effectiveHoldings({
    unmatchedWeight: 0,
    unmatchedPositions: 0,
    ...input,
  });
}

const TIGHT = 1e-9;

describe("the fixtures", () => {
  it("1. one company 100% is one holding, core and broad together", () => {
    const result = holdings({ companies: [company(1, 1)] });

    expect(result.core).toBeCloseTo(1, 12);
    expect(result.broad).toBeCloseTo(1, 12);
    expect(result.companies).toBe(1);
    expect(result.coveragePct).toBeCloseTo(100, 12);
  });

  it("2. four companies at 25% are four, and that is the only time all three agree", () => {
    const result = holdings({
      companies: [
        company(0.25, 0.25),
        company(0.25, 0.25),
        company(0.25, 0.25),
        company(0.25, 0.25),
      ],
    });

    expect(result.core).toBeCloseTo(4, 9);
    expect(result.broad).toBeCloseTo(4, 9);
    expect(result.companies).toBe(4);
    expect(result.core).toBeCloseTo(result.companies ?? NaN, 9);
  });

  it("3. 75% / 25%", () => {
    const result = holdings({ companies: [company(0.75, 0.75), company(0.25, 0.25)] });

    expect(result.core).toBeCloseTo(1.6, 9);
    expect(result.broad).toBeCloseTo(1.754765351, 9);
  });

  it("4. 50% / 30% / 20%", () => {
    const result = holdings({
      companies: [company(0.5, 0.5), company(0.3, 0.3), company(0.2, 0.2)],
    });

    expect(result.core).toBeCloseTo(2.631578947, 9);
    expect(result.broad).toBeCloseTo(2.800094073, 9);
  });

  it("5. a company reached through a fund and directly is one company", () => {
    // 50% of fund A (X 60%, Y 40%) + 50% of X held directly.
    const result = holdings({
      companies: [company(0.8, 0.3, 0.5), company(0.2, 0.2)],
    });

    expect(result.core).toBeCloseTo(1.470588235, 9);
    expect(result.broad).toBeCloseTo(1.649384888, 9);
    // The disjoint pair is the same arithmetic before the merge, and the merge is what
    // makes the headline lower than it.
    expect(result.coreDisjoint).toBeCloseTo(2.631578947, 9);
    expect(result.broadDisjoint).toBeCloseTo(2.800094073, 9);
    expect(result.core!).toBeLessThan(result.coreDisjoint!);
    expect(result.broad!).toBeLessThan(result.broadDisjoint!);
  });

  it("6. two funds holding the same two companies are two companies, not four", () => {
    const result = holdings({
      companies: [company(0.5, 0.25, 0.25), company(0.5, 0.25, 0.25)],
    });

    expect(result.core).toBeCloseTo(2, 9);
    expect(result.broad).toBeCloseTo(2, 9);
    expect(result.coreDisjoint).toBeCloseTo(4, 9);
    expect(result.broadDisjoint).toBeCloseTo(4, 9);
  });

  it("7. cash is outside the denominator: adding 20% of it changes neither count", () => {
    const withCash = holdings({
      companies: [company(0.48, 0.48), company(0.32, 0.32)],
      excludedNonCompanyWeight: 0.2,
    });
    const without = holdings({
      companies: [company(0.6, 0.6), company(0.4, 0.4)],
    });

    expect(withCash.core).toBeCloseTo(1.923076923, 9);
    expect(withCash.broad).toBeCloseTo(1.960131704, 9);
    expect(withCash.core).toBeCloseTo(without.core!, 12);
    expect(withCash.broad).toBeCloseTo(without.broad!, 12);
    expect(withCash.excludedNonCompanyWeight).toBeCloseTo(0.2, 12);
  });

  it("8. unmatched weight lowers coverage without becoming a company", () => {
    const result = holdings({
      companies: [company(0.5, 0.5), company(0.3, 0.3)],
      unmatchedWeight: 0.2,
      unmatchedPositions: 4,
    });

    expect(result.core).toBeCloseTo(1.882352941, 9);
    expect(result.broad).toBeCloseTo(1.937819241, 9);
    expect(result.coveragePct).toBeCloseTo(80, 12);
    expect(result.band).toBe("full");
    // The range puts the unmatched weight back: once as one holding, once as four.
    expect(result.coreRange?.[0]).toBeCloseTo(2.631578947, 9);
    expect(result.coreRange?.[1]).toBeCloseTo(2.857142857, 9);
    expect(result.broadRange?.[0]).toBeCloseTo(2.800094073, 9);
    expect(result.broadRange?.[1]).toBeCloseTo(3.69474628, 9);
  });

  it("9. one large position and a ten-company tail: the top ten carry the count", () => {
    const companies = [company(0.5, 0.5)];
    for (let index = 0; index < 10; index += 1) companies.push(company(0.05, 0.05));
    const result = holdings({ companies });

    expect(result.core).toBeCloseTo(3.636363636, 9);
    expect(result.broad).toBeCloseTo(6.32455532, 9);
    expect(result.topTenConcentrationShare).toBeCloseTo(0.990909091, 9);
    expect(result.topTenBreadthShare).toBeCloseTo(0.918790182, 9);
  });

  it("10. one large position and five hundred small ones: the gap case", () => {
    const companies = [company(0.5, 0.5)];
    for (let index = 0; index < 500; index += 1) companies.push(company(0.001, 0.001));
    const result = holdings({ companies });

    expect(result.core).toBeCloseTo(3.992015968, 9);
    expect(result.broad).toBeCloseTo(44.72135955, 9);
    expect(result.companies).toBe(501);
  });
});

describe("the invariant", () => {
  it("1 <= Core <= Broad <= N, with equal weights the only coincidence", () => {
    const shapes = [
      [1],
      [0.5, 0.5],
      [0.9, 0.05, 0.05],
      [0.4, 0.3, 0.2, 0.1],
      [0.5, ...Array.from({ length: 500 }, () => 0.001)],
    ];

    for (const shape of shapes) {
      const total = shape.reduce((sum, weight) => sum + weight, 0);
      const result = holdings({
        companies: shape.map((weight) => company(weight, weight)),
      });
      expect(result.core).toBeGreaterThanOrEqual(1);
      expect(result.core!).toBeLessThanOrEqual(result.broad!);
      expect(result.broad!).toBeLessThanOrEqual(result.companies! + TIGHT);
      expect(result.matchedWeight).toBeCloseTo(total, 12);
    }
  });
});
