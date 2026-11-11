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
  .map((weights: readonly number[]): readonly number[] => weights);

function build(weights: readonly number[], unmatched = 0, positions = 0) {
  return effectiveHoldings({
    companies: weights.map((weight: number) => ({
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
      fc.property(portfolio, (weights: readonly number[]) => {
        const total = weights.reduce((sum: number, weight: number) => sum + weight, 0);
        const shares = weights.map((weight: number) => weight / total);
        const sum = shares.reduce((acc: number, share: number) => acc + share, 0);
        expect(Math.abs(sum - 1)).toBeLessThanOrEqual(1e-12);
      }),
      { numRuns: RUNS },
    );
  });

  it("1 <= Core <= Broad <= N, and equal weights put all three on N", () => {
    fc.assert(
      fc.property(portfolio, (weights: readonly number[]) => {
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
      fc.property(fc.integer({ min: 1, max: 200 }), (count: number) => {
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
      .map((weights: readonly number[]) =>
        weights.map((weight: number) => ({
          weight,
          sources: [{ weight: weight * 0.6 }, { weight: weight * 0.4 }],
        })),
      );

    fc.assert(
      fc.property(overlapping, (companies: EffectiveInput["companies"]) => {
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
        (weights: readonly number[], k: number) => {
          const base = build(weights);
          const scaled = build(weights.map((weight: number) => weight * k));
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
      fc.property(portfolio, (weights: readonly number[]) => {
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
        (weights: readonly number[], cash: number) => {
          const without = effectiveHoldings({
            companies: weights.map((weight: number) => ({
              weight,
              sources: [{ weight }],
            })),
            unmatchedWeight: 0,
            unmatchedPositions: 0,
          });
          const withCash = effectiveHoldings({
            companies: weights.map((weight: number) => ({
              weight,
              sources: [{ weight }],
            })),
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
        (weights: readonly number[], unmatched: number, positions: number) => {
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

          // The range is the same pair recomputed over the *whole* portfolio, so its
          // denominator is Q = T + unmatched rather than T and it is not a bracket of
          // Core/Broad above: renormalising the matched companies down to make room for
          // the unmatched money can move the whole-portfolio count below the
          // matched-only one. "The whole-portfolio range" below is the deterministic
          // case — ten equal names plus 2.5 unmatched is Core 10 against a floor of
          // 9.615 — and the ordering is all that holds between the two bounds.
          expect(partial.coreRange![0]).toBeLessThanOrEqual(
            partial.coreRange![1] + 1e-12,
          );
          expect(partial.broadRange![0]).toBeLessThanOrEqual(
            partial.broadRange![1] + 1e-12,
          );

          // What *is* guaranteed: `[0]` is the whole-portfolio pair with all the
          // unmatched money in one holding, `[1]` is the same with it spread over
          // `unmatchedPositions` equal ones, and every other split lands between. Each
          // bound is checked against `build` — the same Core/Broad path the rest of this
          // file tests — rather than by restating the arithmetic here. 10 digits because
          // Q is reached through a different summation than the one `build` uses; a
          // wrong bound is off by O(1), not by 1e-13.
          const one = build([...weights, unmatched]);
          expect(partial.coreRange![0]).toBeCloseTo(one.core!, 10);
          expect(partial.broadRange![0]).toBeCloseTo(one.broad!, 10);

          const parts = Math.max(1, positions);
          const spread = build([
            ...weights,
            ...Array.from({ length: parts }, () => unmatched / parts),
          ]);
          expect(partial.coreRange![1]).toBeCloseTo(spread.core!, 10);
          expect(partial.broadRange![1]).toBeCloseTo(spread.broad!, 10);
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
        (weights: readonly number[], short: number) => {
          const base = build(weights);
          const withShort = effectiveHoldings({
            companies: [
              ...weights.map((weight: number) => ({ weight, sources: [{ weight }] })),
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

describe("the whole-portfolio range", () => {
  // Hand-calculated from the definitions in effective-holdings.ts. Ten equal companies
  // of weight 1 give T = 10 and Σw² = 10, so Core = T²/Σw² = 10 and Broad = exp(ln 10)
  // = 10. Adding 2.5 of unmatched weight puts the whole-portfolio denominator at
  // Q = 12.5: with all of it in one holding the floor is
  //   12.5² / (10·1² + 2.5²) = 156.25 / 16.25 = 9.615384…
  // which is *below* Core. That is the claim the property above used to make — "putting
  // the unmatched money back can only spread the portfolio further" — and it is false:
  // a count over Q is not a count over T.
  const tenEqualCompanies = Array.from({ length: 10 }, () => ({
    weight: 1,
    sources: [{ weight: 1 }],
  }));

  it("puts the range on the whole-portfolio denominator, so its floor can sit below Core", () => {
    const result = effectiveHoldings({
      companies: tenEqualCompanies,
      unmatchedWeight: 2.5,
      unmatchedPositions: 1,
    });

    expect(result.coveragePct).toBeCloseTo(80, 9);
    expect(result.band).toBe("full");
    expect(result.core).toBeCloseTo(10, 9);
    expect(result.broad).toBeCloseTo(10, 9);

    // One unmatched position, so the range is a point: 156.25/16.25 = 9.615384…
    expect(result.coreRange![0]).toBeCloseTo(156.25 / 16.25, 12);
    expect(result.coreRange![1]).toBeCloseTo(156.25 / 16.25, 12);
    // The assertion the property above used to make, stated where it can be seen to
    // fail by 0.38 rather than by a rounding step.
    expect(result.coreRange![0]).toBeLessThan(result.core!);
    // Broad over Q: exp(−10·0.08·ln 0.08 − 0.2·ln 0.2) = exp(2.3424705) = 10.4069…
    expect(result.broadRange![0]).toBeCloseTo(10.407, 3);
    expect(result.broadRange![1]).toBeCloseTo(10.407, 3);
  });

  it("spreads the unmatched money over `unmatchedPositions` equal holdings for the ceiling", () => {
    const result = effectiveHoldings({
      companies: tenEqualCompanies,
      unmatchedWeight: 2.5,
      unmatchedPositions: 5,
    });

    // Floor unchanged — all of it in one holding. Ceiling:
    // 12.5² / (10 + 2.5²/5) = 156.25 / 11.25 = 13.888…
    expect(result.coreRange![0]).toBeCloseTo(156.25 / 16.25, 12);
    expect(result.coreRange![1]).toBeCloseTo(156.25 / 11.25, 12);
    // Broad ceiling: exp(2.3424705 + 0.2·ln 5) = exp(2.6643621) = 14.3587…
    expect(result.broadRange![0]).toBeCloseTo(10.407, 3);
    expect(result.broadRange![1]).toBeCloseTo(14.359, 3);
  });

  // The exact counterexample fast-check printed when deploy-site went red on 2026-11-10
  // (run 42770129517, seed 913528741, shrunk 1,765 times): nine companies and
  // 792,727.62 of unmatched weight in one position, landing on the 60% coverage edge
  // where the discarded `coreRange[0] >= core` claim failed by 1e-12. At this input the
  // two are mathematically equal, so only the rounding of T decided it — the case above
  // is the same falsehood with room to see it.
  it("pinned CI counterexample, on the 60% edge, is the whole-portfolio pair", () => {
    const weights = [
      181697.77900302372, 466017.14922029746, 1.7552995824223188, 118575.89134444504,
      229273.1333619948, 0.000019409551044280505, 191488.86132440835,
      0.000001279245330121294, 2036.866423932359,
    ];
    const unmatched = 792727.6239989144;
    const companies = weights.map((weight) => ({ weight, sources: [{ weight }] }));

    const result = effectiveHoldings({
      companies,
      unmatchedWeight: unmatched,
      unmatchedPositions: 1,
    });
    // The same portfolio with the unmatched money standing in as a tenth company: one
    // position, so the whole-portfolio pair is the range.
    const one = effectiveHoldings({
      companies: [...companies, { weight: unmatched, sources: [{ weight: unmatched }] }],
      unmatchedWeight: 0,
      unmatchedPositions: 0,
    });

    expect(result.coveragePct).toBeCloseTo(60, 6);
    expect(result.band).toBe("partial");
    expect(result.coreRange![0]).toBeCloseTo(one.core!, 9);
    expect(result.broadRange![0]).toBeCloseTo(one.broad!, 9);
  });
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
