/** @vitest-environment node */
import { describe, expect, it } from "vitest";

import { TIER_AS_OF, TIER_CONVENTION, TIER_SETS, tierOf } from "./country-tier";

/**
 * The classification is a *convention*, so what can silently go wrong is not a typo but a
 * convention drift: a country moved between lists in one place and not another, a code
 * added without its reason, or a provider's own count no longer matching ours. The counts
 * asserted here are FTSE's published numbers as of 2026-11-05 — 26 developed markets
 * including the United States (25 ex-US by FTSE's count, which treats Belgium and
 * Luxembourg as one market, listed separately here) and 23 emerging (9 advanced plus 14
 * secondary) — so an edit that changes the list without changing the vintage fails.
 *
 * The three assignment rules that make the table total are tested separately, because
 * they are the part a reader is most likely to disagree with: offshore holding domiciles
 * are the United States, Puerto Rico is the United States, and the European frontier is
 * developed ex-US.
 */

const { developedExUs, emerging, offshoreHoldco, usTerritory, advancedFrontier } =
  TIER_SETS;

const ALL_SETS = [
  ["developedExUs", developedExUs],
  ["emerging", emerging],
  ["offshoreHoldco", offshoreHoldco],
  ["usTerritory", usTerritory],
  ["advancedFrontier", advancedFrontier],
] as const;

describe("the market classification", () => {
  it("matches the published counts for the vintage", () => {
    expect([...developedExUs]).toHaveLength(26);
    expect([...emerging]).toHaveLength(23);
    expect([...offshoreHoldco]).toHaveLength(11);
    expect([...usTerritory]).toHaveLength(1);
    expect([...advancedFrontier]).toHaveLength(9);
  });

  it("keeps every list disjoint, so no country is in two", () => {
    for (let left = 0; left < ALL_SETS.length; left += 1) {
      for (let right = left + 1; right < ALL_SETS.length; right += 1) {
        const [leftName, leftSet] = ALL_SETS[left]!;
        const [rightName, rightSet] = ALL_SETS[right]!;
        const both = [...leftSet].filter((code) => rightSet.has(code));
        expect({ leftName, rightName, both }).toEqual({ leftName, rightName, both: [] });
      }
    }
  });

  it("holds only upper-case two-letter domicile codes", () => {
    const malformed = ALL_SETS.flatMap(([, set]) =>
      [...set].filter((code) => !/^[A-Z]{2}$/.test(code)),
    );
    expect(malformed).toEqual([]);
  });

  it("names its vintage and its convention, so the table can be dated", () => {
    expect(TIER_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(TIER_CONVENTION).toContain("FTSE");
  });

  it("classifies the United States on its own", () => {
    expect(tierOf("US")).toBe("US");
  });

  it("follows FTSE where FTSE disagrees with MSCI and the IMF", () => {
    // The disagreements that make the convention visible. If one of these flips, the
    // table has silently switched conventions rather than been corrected.
    expect(tierOf("KR")).toBe("DM"); // MSCI: emerging
    expect(tierOf("PL")).toBe("DM"); // MSCI: emerging
    expect(tierOf("GR")).toBe("DM"); // FTSE developed since 2026-09-21
    expect(tierOf("TW")).toBe("EM"); // IMF: advanced
    expect(tierOf("IS")).toBe("EM"); // MSCI: frontier
    expect(tierOf("RO")).toBe("EM"); // MSCI: frontier
    expect(tierOf("VN")).toBe("EM"); // MSCI: frontier
    expect(tierOf("LU")).toBe("DM"); // FTSE lists it with Belgium; MSCI keeps it separate
  });

  it("puts an offshore holding domicile in the United States, not in a fourth bucket", () => {
    // Where a company is registered, not where it trades. On the 2026-11-04.4 release
    // these were 1.44% of gross weight and 96% of everything the old fourth bucket held.
    for (const code of [
      "BM",
      "KY",
      "VG",
      "GG",
      "JE",
      "IM",
      "PA",
      "MH",
      "BS",
      "GI",
      "MC",
    ]) {
      expect(tierOf(code)).toBe("US");
    }
  });

  it("puts a United States territory in the United States", () => {
    expect(tierOf("PR")).toBe("US");
  });

  it("puts the European frontier in developed ex-US, not in emerging", () => {
    // Frontier to FTSE, advanced to the IMF, in the single market and trading in Europe.
    for (const code of ["BG", "CY", "EE", "HR", "LT", "LV", "MT", "SI", "SK"]) {
      expect(tierOf(code)).toBe("DM");
    }
  });

  it("puts the remaining frontier markets in emerging, because a third bucket has no fourth place", () => {
    for (const code of [
      "KZ", // Kazakhstan
      "AR", // Argentina
      "PE", // Peru — FTSE demoted it to frontier; MSCI still calls it emerging
      "MA", // Morocco
      "NG", // Nigeria
      "MU", // Mauritius
      "KE", // Kenya
      "RU", // Russia — suspended
      "FO", // Faroe Islands
      "LI", // Liechtenstein
      "LK", // Sri Lanka
      "BD", // Bangladesh
      "PK", // Pakistan
      "BH", // Bahrain
      "OM", // Oman
      "JO", // Jordan
      "TN", // Tunisia
      "BW", // Botswana
      "GH", // Ghana
      "PG", // Papua New Guinea
    ]) {
      expect(tierOf(code)).toBe("EM");
    }
  });

  it("answers null for a missing country rather than inventing one", () => {
    // `null` is "the release declines to place this company", which the Markets bar
    // answers from the contested map. It is never defaulted to a bucket here.
    expect(tierOf(null)).toBeNull();
    expect(tierOf(undefined)).toBeNull();
    expect(tierOf("")).toBeNull();
  });

  it("normalises case and padding, so a lower-case code is not silently emerging", () => {
    // The residue rule is total, so without normalisation "kr" would fall through to
    // emerging and put Korea in the wrong bucket with nothing on screen to show it.
    expect(tierOf("kr")).toBe("DM");
    expect(tierOf(" ky ")).toBe("US");
  });
});
