import { describe, expect, it } from "vitest";

import {
  ATTRIBUTED_LABEL,
  IDENTIFIED_LABEL,
  coveragePair,
  coverageSentence,
  coverageSleeve,
  sleeveLine,
  sleeveShowsIdentified,
} from "@/lib/coverage";

/**
 * The dual-read rule and the two labels.
 *
 * The rule these tests defend is the release contract: a document from an older release
 * carries no `identified_pct`, and the page must then render the one figure it rendered
 * before. The second rule is the product one — the identified share can never print a
 * word that would let a reader take it for company coverage.
 */
describe("coveragePair", () => {
  it("returns one figure when the release does not carry the second", () => {
    expect(coveragePair({ coverage_pct: 88.64 })).toEqual({
      attributed: 88.64,
      identified: null,
    });
  });

  it("treats an explicit null as absent", () => {
    expect(coveragePair({ coverage_pct: 62.47, identified_pct: null })).toEqual({
      attributed: 62.47,
      identified: null,
    });
  });

  it("drops a second figure that rounds to the same printed number", () => {
    // 88.64 and 88.61 both print as `88.6%`: two labels over one number would imply a
    // distinction the page cannot show.
    expect(coveragePair({ coverage_pct: 88.64, identified_pct: 88.61 })).toEqual({
      attributed: 88.64,
      identified: null,
    });
  });

  it("keeps both when they differ at the printed precision", () => {
    expect(coveragePair({ coverage_pct: 88.64, identified_pct: 99.51 })).toEqual({
      attributed: 88.64,
      identified: 99.51,
    });
  });

  it("ignores a non-finite figure rather than printing NaN", () => {
    expect(
      coveragePair({ coverage_pct: 70, identified_pct: Number.NaN }).identified,
    ).toBeNull();
  });

  it("labels the second figure without the word 'coverage'", () => {
    // The failure this change exists to prevent: a reader taking identification for
    // attribution. The label names the quantity instead of borrowing the band's word.
    expect(IDENTIFIED_LABEL.toLowerCase()).not.toContain("coverage");
    expect(IDENTIFIED_LABEL.toLowerCase()).not.toContain("covered");
    expect(ATTRIBUTED_LABEL).toContain("attributed");
  });

  it("writes the sentence with both numbers, attributed last", () => {
    expect(coverageSentence(88.64, 99.51)).toBe(
      "We know which security 99.5% of this fund's weight is; 88.6% of it is attributed to a named company.",
    );
    expect(coverageSentence(88.64, null)).toBe("");
  });
});

describe("coverageSleeve", () => {
  const doc = {
    coverage_by_cat: {
      equity: 97.1,
      debt: 41.2,
      cash: null,
      derivative: null,
      fund: 88.3,
      other: null,
    },
    identified_by_cat: {
      equity: 99.9,
      debt: 88.0,
      cash: null,
      derivative: null,
      fund: 99.2,
      other: null,
    },
  };

  it("keeps the six classes in a fixed order", () => {
    expect(coverageSleeve(doc).map((row) => row.cat)).toEqual([
      "equity",
      "debt",
      "cash",
      "derivative",
      "fund",
      "other",
    ]);
  });

  it("keeps a class the fund does not hold null on both sides", () => {
    const cash = coverageSleeve(doc).find((row) => row.cat === "cash");
    expect(cash).toEqual({ cat: "cash", attributed: null, identified: null });
  });

  it("never borrows the attributed figure for the identified one", () => {
    const rows = coverageSleeve({
      coverage_by_cat: {
        equity: 97.1,
        debt: null,
        cash: null,
        derivative: null,
        fund: null,
        other: null,
      },
    });
    expect(rows.find((row) => row.cat === "equity")).toEqual({
      cat: "equity",
      attributed: 97.1,
      identified: null,
    });
  });

  it("renders nothing new when the release has no identified sleeve", () => {
    expect(
      sleeveShowsIdentified(coverageSleeve({ coverage_by_cat: doc.coverage_by_cat })),
    ).toBe(false);
    expect(sleeveShowsIdentified(coverageSleeve(doc))).toBe(true);
  });

  it("prints the equity line with both figures and the band words on the first", () => {
    const equity = coverageSleeve(doc).find((row) => row.cat === "equity");
    expect(equity).toBeDefined();
    expect(sleeveLine(equity!)).toBe("equity 97.1% covered · 99.9% identified");
  });

  it("prints the band label when a class is only partly attributed", () => {
    const debt = coverageSleeve(doc).find((row) => row.cat === "debt");
    expect(debt).toBeDefined();
    expect(sleeveLine(debt!)).toBe("debt 41.2% not covered · 88.0% identified");
  });

  it("prints the attributed half alone when there is no identified figure", () => {
    expect(sleeveLine({ cat: "equity", attributed: 66.4, identified: null })).toBe(
      "equity partial 66.4%",
    );
  });
});
