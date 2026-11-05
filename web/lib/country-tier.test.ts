/** @vitest-environment node */
import { describe, expect, it } from "vitest";

import {
  CLASSIFICATION_ROWS,
  DEFAULT_PROVIDER,
  PROVIDERS,
  TIER_AS_OF,
  TIER_CONVENTION,
  marketTierOf,
  tierOf,
} from "./country-tier";

/**
 * The classification is a *convention*, so what can silently go wrong is not a typo but a
 * convention drift: a country moved between lists in one place and not another, a code
 * added without its reason, or a provider's own count no longer matching ours.
 *
 * Two things are asserted here that a normal unit test would not bother with.
 *
 * **The counts.** MSCI publishes 23 developed and 24 emerging markets as of the 2026
 * review, with Greece moving to developed and Bulgaria to frontier at the May 2027 Index
 * Review. An edit that changes a list without changing the vintage fails.
 *
 * **The FTSE regression.** The site shipped an FTSE table on 2026-11-05. The migration
 * must not change what a reader sees when they ask for FTSE, so the last test in this
 * file re-derives the old table from the old five sets and asserts the new one agrees
 * over every one of the 676 ISO alpha-2 codes. That is the gate that makes "FTSE is one
 * click away" a claim rather than a hope.
 */

const ALL_CODES = Array.from({ length: 26 * 26 }, (_, index) => {
  const first = String.fromCharCode(65 + Math.floor(index / 26));
  const second = String.fromCharCode(65 + (index % 26));
  return first + second;
});

/** The table that shipped on 2026-11-05, kept here as the regression oracle. */
const SHIPPED_FTSE = {
  developedExUs: new Set(
    "AT AU BE CA CH DE DK ES FI FR GB GR HK IE IL IT JP KR LU NL NO NZ PL PT SE SG".split(
      " ",
    ),
  ),
  emerging: new Set(
    "AE BR CL CO CN CZ EG HU ID IN IS KW MX MY PH QA RO SA TH TR TW VN ZA".split(" "),
  ),
  offshoreHoldco: new Set("BM BS GG GI IM JE KY MC MH PA VG".split(" ")),
  usTerritory: new Set(["PR"]),
  advancedFrontier: new Set("BG CY EE HR LT LV MT SI SK".split(" ")),
};

//: The four United States territories other than Puerto Rico. They were absent from the
//: table that shipped on 2026-11-05 and fell through to emerging; they are United States
//: territory under both publishers, so they are now in the shared bucket. This is the one
//: deliberate difference between the shipped FTSE view and the current one, and it is a
//: correction rather than a migration.
const TERRITORIES_ADDED = new Set(["AS", "GU", "MP", "VI"]);

function shippedTier(code: string): "US" | "DM" | "EM" {
  if (code === "US") return "US";
  if (TERRITORIES_ADDED.has(code)) return "US";
  if (SHIPPED_FTSE.usTerritory.has(code) || SHIPPED_FTSE.offshoreHoldco.has(code))
    return "US";
  if (SHIPPED_FTSE.developedExUs.has(code) || SHIPPED_FTSE.advancedFrontier.has(code))
    return "DM";
  return "EM";
}

function tiersAt(provider: "MSCI" | "FTSE", asOf: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [iso2, from, to, tier] of CLASSIFICATION_ROWS[provider]) {
    if (from <= asOf && (to === null || asOf < to)) out.set(iso2, tier);
  }
  return out;
}

describe("the market classification", () => {
  it("defaults to MSCI, because that is what the funds it looks through benchmark to", () => {
    expect(DEFAULT_PROVIDER).toBe("MSCI");
    expect(PROVIDERS).toEqual(["MSCI", "FTSE"]);
    expect(TIER_CONVENTION).toContain("MSCI");
  });

  it("names its vintage, so the table can be dated", () => {
    expect(TIER_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("matches MSCI's published counts for the vintage", () => {
    const tiers = tiersAt("MSCI", TIER_AS_OF);
    const count = (tier: string) => [...tiers.values()].filter((t) => t === tier).length;
    expect(count("DEVELOPED")).toBe(23);
    expect(count("EMERGING")).toBe(24);
    expect(count("FRONTIER")).toBe(20);
    expect(count("STANDALONE")).toBe(2);
    // Luxembourg is absent on purpose: MSCI has no Luxembourg market and classifies
    // Luxembourg-incorporated issuers by their operating market.
    expect(tiers.has("LU")).toBe(false);
  });

  it("matches FTSE's published counts for the vintage", () => {
    const tiers = tiersAt("FTSE", TIER_AS_OF);
    const count = (tier: string) => [...tiers.values()].filter((t) => t === tier).length;
    expect(count("DEVELOPED")).toBe(27); // 26 ex-US plus the United States
    expect(count("EMERGING")).toBe(23);
    expect(count("FRONTIER")).toBe(24);
  });

  it("keeps every list disjoint, so no country is in two tiers on one day", () => {
    for (const provider of PROVIDERS) {
      for (const asOf of [TIER_AS_OF, "2027-06-01", "2030-01-01"]) {
        const seen = new Map<string, string>();
        for (const [iso2, from, to, tier] of CLASSIFICATION_ROWS[provider]) {
          if (!(from <= asOf && (to === null || asOf < to))) continue;
          expect({ provider, asOf, iso2, already: seen.get(iso2), tier }).toEqual({
            provider,
            asOf,
            iso2,
            already: undefined,
            tier,
          });
          seen.set(iso2, tier);
        }
      }
    }
  });

  it("holds only upper-case two-letter domicile codes", () => {
    const malformed = PROVIDERS.flatMap((provider) =>
      CLASSIFICATION_ROWS[provider]
        .map((row) => row[0])
        .filter((code) => !/^[A-Z]{2}$/.test(code)),
    );
    expect(malformed).toEqual([]);
  });

  it("classifies the United States on its own", () => {
    expect(tierOf("US")).toBe("US");
    expect(tierOf("US", { provider: "FTSE" })).toBe("US");
  });

  it("follows MSCI where MSCI disagrees with FTSE", () => {
    // The disagreements that make the convention visible. If one of these flips, the
    // table has silently switched conventions rather than been corrected.
    expect(tierOf("KR")).toBe("EM"); // FTSE: developed
    expect(tierOf("PL")).toBe("EM"); // FTSE: developed
    expect(tierOf("GR")).toBe("EM"); // FTSE: developed since 2026-09-21
    expect(tierOf("PE")).toBe("EM"); // FTSE: frontier
    expect(tierOf("TW")).toBe("EM"); // IMF: advanced
    expect(tierOf("HK")).toBe("DM");
    expect(tierOf("IL")).toBe("DM");
    expect(tierOf("SG")).toBe("DM");
  });

  it("follows FTSE where FTSE disagrees with MSCI", () => {
    expect(tierOf("KR", { provider: "FTSE" })).toBe("DM");
    expect(tierOf("PL", { provider: "FTSE" })).toBe("DM");
    expect(tierOf("GR", { provider: "FTSE" })).toBe("DM");
    expect(tierOf("PE", { provider: "FTSE" })).toBe("EM"); // frontier folds into emerging
    expect(tierOf("TW", { provider: "FTSE" })).toBe("EM");
  });

  it("folds frontier and standalone into emerging, because a third bucket has no fourth place", () => {
    for (const code of [
      "VN",
      "RO",
      "IS",
      "KZ",
      "MA",
      "NG",
      "MU",
      "KE",
      "LK",
      "BD",
      "PK",
    ]) {
      expect({ code, tier: tierOf(code) }).toEqual({ code, tier: "EM" });
      expect({ code, tier: marketTierOf(code) }).toEqual({ code, tier: "FRONTIER" });
    }
    for (const code of ["AR", "BG"]) {
      expect({ code, tier: tierOf(code) }).toEqual({ code, tier: "EM" });
      expect({ code, tier: marketTierOf(code) }).toEqual({ code, tier: "STANDALONE" });
    }
  });

  it("moves Greece and Bulgaria on the day the May 2027 review implements", () => {
    // Loaded the day they were announced, effective the day they take effect. The
    // boundary is the one date to check when MSCI publishes the review calendar.
    expect(marketTierOf("GR", { asOf: "2027-05-31" })).toBe("EMERGING");
    expect(marketTierOf("GR", { asOf: "2027-06-01" })).toBe("DEVELOPED");
    expect(tierOf("GR", { asOf: "2027-05-31" })).toBe("EM");
    expect(tierOf("GR", { asOf: "2027-06-01" })).toBe("DM");

    expect(marketTierOf("BG", { asOf: "2027-05-31" })).toBe("STANDALONE");
    expect(marketTierOf("BG", { asOf: "2027-06-01" })).toBe("FRONTIER");
    // Both fold into emerging either way, so the bar does not move — only the label does.
    expect(tierOf("BG", { asOf: "2027-05-31" })).toBe("EM");
    expect(tierOf("BG", { asOf: "2027-06-01" })).toBe("EM");
  });

  it("puts an offshore holding domicile in the United States, not in a fourth bucket", () => {
    // Where a company is registered, not where it trades. On the 2026-11-05 release
    // these were 1.44% of gross weight and 96% of everything the old fourth bucket held.
    for (const provider of PROVIDERS) {
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
        expect({ provider, code, tier: tierOf(code, { provider }) }).toEqual({
          provider,
          code,
          tier: "US",
        });
      }
    }
  });

  it("puts a United States territory in the United States", () => {
    expect(tierOf("PR")).toBe("US");
    expect(tierOf("PR", { provider: "FTSE" })).toBe("US");
  });

  it("puts the European frontier in developed ex-US under FTSE and emerging under MSCI", () => {
    // Frontier to FTSE, advanced to the IMF, in the single market and trading in Europe.
    // MSCI calls them frontier, so the MSCI view folds them into emerging: the
    // provider's answer is the one that ships.
    for (const code of ["BG", "CY", "EE", "HR", "LT", "LV", "MT", "SI", "SK"]) {
      expect({ code, tier: tierOf(code, { provider: "FTSE" }) }).toEqual({
        code,
        tier: "DM",
      });
      expect({ code, tier: tierOf(code) }).toEqual({ code, tier: "EM" });
    }
  });

  it("places Luxembourg in developed ex-US under both, by a stated rule rather than a tier", () => {
    // MSCI has no Luxembourg market; it classifies Luxembourg-incorporated issuers by
    // their operating market. The domicile is a proxy for a developed European market,
    // and the override table corrects the ones that are not (Spotify is United States).
    expect(tierOf("LU")).toBe("DM");
    expect(tierOf("LU", { provider: "FTSE" })).toBe("DM");
    expect(marketTierOf("LU")).toBe("UNCLASSIFIED");
    expect(marketTierOf("LU", { provider: "FTSE" })).toBe("DEVELOPED");
  });

  it("answers null for a missing country rather than inventing one", () => {
    // `null` is "the release declines to place this company", which the Markets bar
    // answers from the contested map. It is never defaulted to a bucket here.
    expect(tierOf(null)).toBeNull();
    expect(tierOf(undefined)).toBeNull();
    expect(tierOf("")).toBeNull();
    expect(marketTierOf(null)).toBeNull();
  });

  it("normalises case and padding, so a lower-case code is not silently emerging", () => {
    // The residue rule is total, so without normalisation "kr" would fall through to
    // emerging and put Korea in the wrong bucket with nothing on screen to show it.
    expect(tierOf("kr")).toBe("EM");
    expect(tierOf(" ky ")).toBe("US");
    expect(tierOf("kr", { provider: "FTSE" })).toBe("DM");
  });

  it("is total over every ISO alpha-2 code, so the bar never has a fourth segment", () => {
    for (const provider of PROVIDERS) {
      const unplaced = ALL_CODES.filter((code) => {
        const tier = tierOf(code, { provider });
        return tier !== "US" && tier !== "DM" && tier !== "EM";
      });
      expect({ provider, unplaced }).toEqual({ provider, unplaced: [] });
    }
  });

  it("reproduces the FTSE table that shipped on 2026-11-05, over all 676 codes", () => {
    // The regression gate for the migration: asking for FTSE must show exactly what the
    // site showed before MSCI became the default. A single code moving here is a
    // behaviour change a reader would see and nobody asked for.
    const drift = ALL_CODES.map((code) => ({
      code,
      shipped: shippedTier(code),
      now: tierOf(code, { provider: "FTSE" }),
    })).filter((row) => row.shipped !== row.now);
    expect(drift).toEqual([]);
  });
});
