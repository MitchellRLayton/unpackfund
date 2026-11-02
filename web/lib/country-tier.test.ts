/** @vitest-environment node */
import { describe, expect, it } from "vitest";

import { TIER_AS_OF, TIER_CONVENTION, TIER_SETS, tierOf } from "./country-tier";

/**
 * The classification is a *convention*, so what can silently go wrong is not a typo but a
 * convention drift: a country moved between lists in one place and not another, a code
 * added without its reason, or a provider's own count no longer matching ours. The counts
 * asserted here are FTSE's published numbers as of 2026-11-02 — 26 developed markets
 * including the United States (25 ex-US by FTSE's count, which treats Belgium and
 * Luxembourg as one market, listed separately here) and 23 emerging (9 advanced plus 14
 * secondary) — so an edit that changes the list without changing the vintage fails.
 */

const { developedExUs, emerging } = TIER_SETS;

describe("the market classification", () => {
  it("matches the published counts for the vintage", () => {
    expect([...developedExUs]).toHaveLength(26);
    expect([...emerging]).toHaveLength(23);
  });

  it("keeps the two lists disjoint, so no country is both", () => {
    const both = [...developedExUs].filter((code) => emerging.has(code));
    expect(both).toEqual([]);
  });

  it("holds only upper-case two-letter domicile codes", () => {
    const malformed = [...developedExUs, ...emerging].filter(
      (code) => !/^[A-Z]{2}$/.test(code),
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
    // The nine disagreements that make the convention visible. If one of these flips,
    // the table has silently switched conventions rather than been corrected.
    expect(tierOf("KR")).toBe("DM"); // MSCI: emerging
    expect(tierOf("PL")).toBe("DM"); // MSCI: emerging
    expect(tierOf("GR")).toBe("DM"); // FTSE developed since 2026-09-21
    expect(tierOf("TW")).toBe("EM"); // IMF: advanced
    expect(tierOf("PE")).toBe("OTHER"); // MSCI: emerging, FTSE: frontier
    expect(tierOf("IS")).toBe("EM"); // MSCI: frontier
    expect(tierOf("RO")).toBe("EM"); // MSCI: frontier
    expect(tierOf("VN")).toBe("EM"); // MSCI: frontier
    expect(tierOf("BG")).toBe("OTHER"); // IMF: advanced
  });

  it("puts the offshore and unclassified domiciles in OTHER, not in emerging", () => {
    // 4.2% of the release's classified companies, most of them offshore holding
    // domiciles: reading KY as emerging would be a fabrication about Cayman.
    for (const code of ["KY", "BM", "VG", "GG", "JE", "IM", "PA", "MH", "AR", "RU"]) {
      expect(tierOf(code)).toBe("OTHER");
    }
  });

  it("answers OTHER for a missing country rather than inventing one", () => {
    expect(tierOf(null)).toBe("OTHER");
    expect(tierOf(undefined)).toBe("OTHER");
    expect(tierOf("")).toBe("OTHER");
  });

  it("does not normalise case, so an unexpected shape is visible rather than absorbed", () => {
    // The release's codes are ISO-3166 alpha-2 upper case and hash-checked; a lower-case
    // code means something upstream changed, and OTHER makes that visible instead of
    // quietly classifying it as Korea.
    expect(tierOf("kr")).toBe("OTHER");
  });
});
