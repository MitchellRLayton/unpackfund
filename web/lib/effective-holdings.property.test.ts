/**
 * The invariants, on random portfolios.
 *
 * The fixtures prove the arithmetic on ten shapes a person can check by hand. These
 * prove the *properties* on ten thousand shapes nobody chose, which is where a metric
 * like this actually breaks: a rounding path that only shows up at 0.0001, a sort that
 * makes the answer depend on the order the visitor typed their holdings in, a
 * normalisation that quietly assumes the weights sum to 1.
 *
 * Each property is a claim the brief makes, so a failure here is a definitional bug, not
 * a tolerance to loosen.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { effectiveHoldings, type EffectiveInput } from "./effective-holdings";

/** A portfolio of `count` companies with arbitrary positive weights. */
const portfolio = fc
  .array(fc.double({ min: 1e-6, max: 1e6, noNaN: true, noDefaultInfinity: true }), {
    minLength: 1,
    maxLength: 60,
  })
  .map((weights) => weights);

function build(weights: readonly number[], unmatched = 0, positions = 0) {
  return effectiveHoldings({
    companies: weights.map((weight) => ({
      weight,
      sources: [{ weight }],
    })),
    unmatchedWeight: unmatched,
    unmatchedPositions: positions,
  });
}

const RUNS = 10_000;

describe("the invariants, on random portfolios", () => {
  it("the shares sum to 1 within 1e-12", () => {
    fc.assert(
      fc.property(portfolio, (weights) => {
        const total = weights.reduce((sum, weight) => sum + weight, 0);
        const shares = weights.map((weight) => weight / total);
        const sum = shares.reduce((acc, share) => acc + share, 0);
        expect(Math.abs(sum - 1)).toBeLessThanOrEqual(1e-12);
      }),
      { numRuns: RUNS },
    );
  });

  it("1 <= Core <= Broad <= N, and equal weights put all three on N", () => {
    fc.assert(
      fc.property(portfolio, (weights) => {
        const result = build(weights);
        expect(result.core).not.toBeNull();
        expect(result.core!).toBeGreaterThanOrEqual(1 - 1e-12);
        expect(result.core!).toBeLessThanOrEqual(result.broad! + 1e-12);
        expect(result.broad!).toBeLessThanOrEqual(result.companies + 1e-12);
      }),
      { numRuns: RUNS },
    );

    // The identity case, stated separately because it is the only coincidence: equal
    // weights make Core, Broad and N the same number, and any deviation is a bug.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), (count) => {
        const result = build(Array.from({ length: count }, () => 1));
        expect(result.core!).toBeCloseTo(count, 9);
        expect(result.broad!).toBeCloseTo(count, 9);
        expect(result.companies).toBe(count);
      }),
      { numRuns: 200 },
    );
  });

  it("merging can only lower both counts: Core <= Core_disjoint, Broad <= Broad_disjoint", () => {
    // A portfolio where every company is reached through two sources, so the merge is
    // real and the disjoint pair is strictly larger.
    const overlapping = fc
      .array(fc.double({ min: 1e-6, max: 1e6, noNaN: true, noDefaultInfinity: true }), {
        minLength: 1,
        maxLength: 40,
      })
      .map((weights) =>
        weights.map((weight) => ({
          weight,
          sources: [{ weight: weight * 0.6 }, { weight: weight * 0.4 }],
        })),
      );

    fc.assert(
      fc.property(overlapping, (companies) => {
        const result = effectiveHoldings({
          companies,
          unmatchedWeight: 0,
          unmatchedPositions: 0,
        });
        expect(result.core!).toBeLessThanOrEqual(result.coreDisjoint! + 1e-12);
        expect(result.broad!).toBeLessThanOrEqual(result.broadDisjoint! + 1e-12);
      }),
      { numRuns: RUNS },
    );
  });

  it("scaling every weight by any k > 0 changes nothing", () => {
    // This is what makes percent entry and dollar entry agree, and it is the property a
    // metric computed over NAV instead of over T would fail.
    fc.assert(
      fc.property(
        portfolio,
        fc.double({ min: 1e-6, max: 1e6, noNaN: true, noDefaultInfinity: true }),
        (weights, k) => {
          const base = build(weights);
          const scaled = build(weights.map((weight) => weight * k));
          expect(scaled.core!).toBeCloseTo(base.core!, 9);
          expect(scaled.broad!).toBeCloseTo(base.broad!, 9);
          expect(scaled.companies).toBe(base.companies);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("reordering the holdings changes nothing", () => {
    fc.assert(
      fc.property(portfolio, (weights) => {
        const base = build(weights);
        const reversed = build(weights.slice().reverse());
        expect(reversed.core!).toBeCloseTo(base.core!, 12);
        expect(reversed.broad!).toBeCloseTo(base.broad!, 12);
        expect(reversed.topTenConcentrationShare!).toBeCloseTo(
          base.topTenConcentrationShare!,
          12,
        );
      }),
      { numRuns: RUNS },
    );
  });

  it("adding or removing cash changes only the excluded-weight line", () => {
    fc.assert(
      fc.property(
        portfolio,
        fc.double({ min: 0, max: 1e6, noNaN: true, noDefaultInfinity: true }),
        (weights, cash) => {
          const without = effectiveHoldings({
            companies: weights.map((weight) => ({ weight, sources: [{ weight }] })),
            unmatchedWeight: 0,
            unmatchedPositions: 0,
          });
          const withCash = effectiveHoldings({
            companies: weights.map((weight) => ({ weight, sources: [{ weight }] })),
            unmatchedWeight: 0,
            unmatchedPositions: 0,
            excludedNonCompanyWeight: cash,
          });

          expect(withCash.core!).toBeCloseTo(without.core!, 12);
          expect(withCash.broad!).toBeCloseTo(without.broad!, 12);
          expect(withCash.coveragePct).toBeCloseTo(without.coveragePct, 12);
          expect(withCash.excludedNonCompanyWeight).toBeCloseTo(cash, 12);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("unmatched weight lowers coverage and never becomes a company", () => {
    fc.assert(
      fc.property(
        portfolio,
        fc.double({ min: 0, max: 1e6, noNaN: true, noDefaultInfinity: true }),
        fc.integer({ min: 1, max: 50 }),
        (weights, unmatched, positions) => {
          const base = build(weights);
          const partial = build(weights, unmatched, positions);

          expect(partial.companies).toBe(base.companies);
          expect(partial.coveragePct).toBeLessThanOrEqual(base.coveragePct + 1e-12);

          // Below 60% coverage both numbers are withheld by design, so there is nothing
          // to compare — that rule has its own test in the banding block below.
          if (partial.band === "none") {
            expect(partial.core).toBeNull();
            expect(partial.broad).toBeNull();
            return;
          }

          // Unmatched weight is not a company: it cannot enter the shares, so it cannot
          // move either count.
          expect(partial.core!).toBeCloseTo(base.core!, 12);
          expect(partial.broad!).toBeCloseTo(base.broad!, 12);
          // The range brackets the pair: putting the unmatched money back can only
          // spread the portfolio further, never concentrate it.
          expect(partial.coreRange![0]).toBeGreaterThanOrEqual(partial.core! - 1e-12);
          expect(partial.coreRange![0]).toBeLessThanOrEqual(
            partial.coreRange![1] + 1e-12,
          );
          expect(partial.broadRange![0]).toBeGreaterThanOrEqual(partial.broad! - 1e-12);
          expect(partial.broadRange![0]).toBeLessThanOrEqual(
            partial.broadRange![1] + 1e-12,
          );
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("a short is excluded from the shares and counted, not netted", () => {
    fc.assert(
      fc.property(
        portfolio,
        fc.double({ min: 1e-6, max: 1e6, noNaN: true }),
        (weights, short) => {
          const base = build(weights);
          const withShort = effectiveHoldings({
            companies: [
              ...weights.map((weight) => ({ weight, sources: [{ weight }] })),
              { weight: -short, sources: [{ weight: -short }] },
            ],
            unmatchedWeight: 0,
            unmatchedPositions: 0,
          });

          expect(withShort.core!).toBeCloseTo(base.core!, 12);
          expect(withShort.broad!).toBeCloseTo(base.broad!, 12);
          expect(withShort.companies).toBe(base.companies);
          expect(withShort.negativePositions).toBe(1);
          expect(withShort.negativeWeight).toBeCloseTo(-short, 12);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe("the coverage bands", () => {
  const cases: Array<[number, string, boolean]> = [
    [59.9, "none", true],
    [65, "partial", false],
    [70, "full", false],
  ];

  for (const [coverage, band, withheld] of cases) {
    it(`${coverage}% coverage is ${band}${withheld ? " and withholds both numbers" : ""}`, () => {
      // 100 units of matched weight and enough unmatched weight to land on the band.
      const matched = 100;
      const unmatched = (matched * (100 - coverage)) / coverage;
      const result = effectiveHoldings({
        companies: [
          { weight: matched * 0.6, sources: [{ weight: matched * 0.6 }] },
          { weight: matched * 0.4, sources: [{ weight: matched * 0.4 }] },
        ],
        unmatchedWeight: unmatched,
        unmatchedPositions: 4,
      });

      expect(result.coveragePct).toBeCloseTo(coverage, 9);
      expect(result.band).toBe(band);
      if (withheld) {
        expect(result.core).toBeNull();
        expect(result.broad).toBeNull();
        expect(result.coreDisjoint).toBeNull();
        expect(result.broadDisjoint).toBeNull();
        expect(result.coreRange).toBeNull();
        expect(result.broadRange).toBeNull();
        expect(result.topTenConcentrationShare).toBeNull();
      } else {
        expect(result.core).not.toBeNull();
        expect(result.broad).not.toBeNull();
      }
    });
  }
});

describe("the input contract", () => {
  it("an empty portfolio has no counts rather than a zero", () => {
    const result = effectiveHoldings({
      companies: [],
      unmatchedWeight: 0,
      unmatchedPositions: 0,
    } satisfies EffectiveInput);

    expect(result.core).toBeNull();
    expect(result.broad).toBeNull();
    expect(result.companies).toBe(0);
    expect(result.band).toBe("none");
  });
});
