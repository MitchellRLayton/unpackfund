import { describe, expect, it } from "vitest";

import { countryName, flagEmoji } from "./country-flag";

/**
 * The 86 codes the live release publishes (2026-11-02.7, `companies/countries.json`).
 * Pinned here because the mark is derived from the code: if a code ever arrives that
 * is not two ASCII letters, the tag would silently lose its mark, and this list is the
 * one place that says which codes the product actually shows.
 */
const PUBLISHED_CODES = [
  "US",
  "IN",
  "JP",
  "CN",
  "CA",
  "GB",
  "AU",
  "KY",
  "SE",
  "DE",
  "KR",
  "FR",
  "TW",
  "TR",
  "CH",
  "IT",
  "NO",
  "HK",
  "IL",
  "SG",
  "BR",
  "ID",
  "ZA",
  "ES",
  "TH",
  "NL",
  "FI",
  "BE",
  "PL",
  "SA",
  "MX",
  "BM",
  "DK",
  "AE",
  "MY",
  "PH",
  "VN",
  "GR",
  "AT",
  "CL",
  "QA",
  "NZ",
  "IE",
  "LU",
  "KW",
  "IS",
  "CO",
  "PT",
  "AR",
  "PE",
  "VG",
  "RO",
  "MA",
  "LK",
  "MH",
  "GG",
  "SI",
  "HU",
  "BD",
  "RU",
  "HR",
  "PK",
  "JE",
  "EG",
  "OM",
  "CZ",
  "PA",
  "CY",
  "JO",
  "LT",
  "IM",
  "NG",
  "KZ",
  "BH",
  "MU",
  "TN",
  "MT",
  "EE",
  "KE",
  "PR",
  "BS",
  "LI",
  "BW",
  "BG",
  "PG",
  "GI",
] as const;

describe("flagEmoji", () => {
  it("turns a code into its two regional indicators", () => {
    expect(flagEmoji("US")).toBe("\u{1F1FA}\u{1F1F8}");
    expect(flagEmoji("TW")).toBe("\u{1F1F9}\u{1F1FC}");
    expect([...flagEmoji("US")]).toHaveLength(2);
  });

  it("gives every published code a mark, and every mark is a flag sequence", () => {
    // The whole point of deriving the mark: no code needs a table entry, so the only
    // way a row loses its flag is a code that is not two letters.
    expect(PUBLISHED_CODES).toHaveLength(86);
    for (const code of PUBLISHED_CODES) {
      const mark = flagEmoji(code);
      expect(mark, code).toHaveLength(4); // two surrogate pairs
      const points = [...mark].map((ch) => ch.codePointAt(0) ?? 0);
      expect(points, code).toEqual([
        0x1f1e6 + code.charCodeAt(0) - 65,
        0x1f1e6 + code.charCodeAt(1) - 65,
      ]);
    }
  });

  it("accepts lower case, because a code is data and not a spelling", () => {
    expect(flagEmoji("us")).toBe(flagEmoji("US"));
  });

  it("returns nothing for anything that is not two letters", () => {
    // A malformed code is a data defect: the tag disappears rather than inventing a
    // country out of stray symbols.
    for (const bad of ["", "U", "USA", "U1", "1S", "U S", "🇺🇸"]) {
      expect(flagEmoji(bad), bad).toBe("");
    }
  });
});

describe("countryName", () => {
  it("names the country, not the code", () => {
    expect(countryName("US")).toBe("United States");
    expect(countryName("GB")).toBe("United Kingdom");
    expect(countryName("TW")).toBe("Taiwan");
  });

  it("names the awkward domiciles the release actually publishes", () => {
    // These are the codes a hand-written table would get wrong or forget: the Crown
    // dependencies, the Caribbean registrations and the territories.
    expect(countryName("KY")).toBe("Cayman Islands");
    expect(countryName("BM")).toBe("Bermuda");
    expect(countryName("VG")).toBe("British Virgin Islands");
    expect(countryName("GG")).toBe("Guernsey");
    expect(countryName("JE")).toBe("Jersey");
    expect(countryName("IM")).toBe("Isle of Man");
    expect(countryName("MH")).toBe("Marshall Islands");
    expect(countryName("PR")).toBe("Puerto Rico");
    expect(countryName("GI")).toBe("Gibraltar");
  });

  it("falls back to the code when the browser has no name for it", () => {
    // `Intl.DisplayNames` answers with the input for an unknown region; the label is
    // then the code, which is what the tag showed before the flag existed.
    expect(countryName("ZZ")).toBe("ZZ");
  });

  it("names every published code, so no row is labelled with a bare code", () => {
    const unnamed = PUBLISHED_CODES.filter((code) => countryName(code) === code);
    expect(unnamed).toEqual([]);
  });
});
