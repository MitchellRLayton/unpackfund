/**
 * Which market a domicile belongs to.
 *
 * The ledger's left edge answers one question — is this company American, developed
 * ex-US, or emerging? — and the answer is a *convention*, not a fact about the world.
 * Three respected publishers disagree about nine countries (Korea, Taiwan, Poland,
 * Greece, Peru, Iceland, Romania, Vietnam, Luxembourg), so a table with no stated
 * convention is a guess wearing a claim's clothes.
 *
 * **The convention is FTSE Russell's equity country classification, as of 2026-11-05.**
 * Chosen because the funds this site looks through are FTSE-indexed: VTI, VT and VXUS
 * track FTSE indexes, so "developed ex-US" here means what it means on the fund's own
 * page. Under MSCI the same portfolio would put Korea (0.8% of VT) in emerging while
 * the funds holding Samsung treat it as developed.
 *
 * **The table is ours, not FTSE's.** A publisher's compilation is licensed material —
 * FTSE's terms require written permission to reproduce its matrix — while a country's
 * tier is a widely published fact. So this is a table *written to* FTSE's published
 * criteria and then cross-checked against the IMF's October 2026 WEO advanced-economy
 * list and MSCI's classification, with the divergences recorded here rather than
 * resolved silently. No FTSE document, PDF, or data file is copied into this repo, and
 * nothing here is fetched at build or run time.
 *
 * Deliberate FTSE positions that a reader may not expect, each checked against the
 * provider's own release:
 *
 * - **Korea and Poland are developed** (MSCI says emerging; the IMF says advanced for
 *   Korea and EMDE for Poland).
 * - **Taiwan is emerging**, and an *advanced* emerging market (the IMF calls it advanced).
 * - **Greece is developed** — FTSE promoted it on 2026-09-21; MSCI does not follow until
 *   the May 2027 index review.
 * - **Peru is not emerging** — FTSE demoted it to frontier; MSCI still calls it emerging.
 * - **Luxembourg is a market** to FTSE and S&P DJI; MSCI classifies its companies by
 *   country of risk instead.
 * - **Bulgaria, Croatia, Cyprus, Estonia, Latvia, Lithuania, Malta, Slovakia and
 *   Slovenia are frontier**, though the IMF calls all nine advanced. "Advanced economy"
 *   and "developed market" are different questions; this table answers the market one.
 *
 * ## Three buckets, and where the rest of the world goes
 *
 * The Markets page shows exactly three segments — United States, International
 * Developed ex-US, Emerging Markets — because that is the split a reader compares
 * against an issuer's own factsheet, and a fourth "no market tier" segment is a
 * question the page cannot answer rather than an answer. So a domicile FTSE does not
 * classify is assigned to the market its securities actually trade in, by one of three
 * stated rules (operator's instruction, 2026-11-05):
 *
 * - **Offshore holding domiciles are the United States.** Bermuda, the Cayman Islands,
 *   the British Virgin Islands, Jersey, Guernsey, the Isle of Man, the Marshall
 *   Islands, Panama, the Bahamas, Gibraltar and Monaco are where a company is
 *   *registered*, not where it trades: the operating business is usually American and
 *   the shares are listed in New York. FTSE reaches the same place from the other
 *   direction — it classifies these companies by country of risk, which for the ones
 *   the funds hold is the United States. This is the single largest correction the
 *   convention makes: on the 2026-11-04.4 release these domiciles were 1.44% of gross
 *   weight, and 96% of everything the old fourth bucket held.
 * - **Puerto Rico is the United States**, because it is a United States territory.
 * - **The European Union and EEA frontier markets are developed ex-US.** Bulgaria,
 *   Croatia, Cyprus, Estonia, Latvia, Lithuania, Malta, Slovakia and Slovenia are
 *   frontier to FTSE and advanced to the IMF; they are in the single market, they trade
 *   in Europe, and calling them emerging would put Estonia in the same bucket as
 *   Vietnam.
 * - **Everything else with no FTSE tier is emerging.** That is the frontier markets —
 *   Kazakhstan, Argentina, Peru, Morocco, Nigeria, Mauritius, Kenya, Sri Lanka,
 *   Bangladesh, Pakistan, Bahrain, Oman, Jordan, Tunisia, Botswana, Ghana, Papua New
 *   Guinea, the Faroe Islands, Russia (suspended) and Liechtenstein. A three-bucket
 *   view has no fourth place for them, and frontier is closer to emerging than to
 *   either of the other two. The whole residue is 0.06% of gross weight.
 *
 * `null` in, `null` out: a company the release declines to place has no tier, and
 * `null` is how that is said. It is never defaulted to a bucket — the Markets bar
 * places such a company from the release's *contested* map instead, which is a
 * different question with its own stated rule.
 *
 * Changing this table is a dated change: update `TIER_AS_OF`, record it in the build
 * log, and let `country-tier.test.ts` (counts, disjointness, spot checks) and
 * `theme.test.ts` (three distinguishable inks) run before it ships.
 */

export type CountryTier = "US" | "DM" | "EM";

/** The vintage of the classification below. A code with a newer provider release is not covered. */
export const TIER_AS_OF = "2026-11-05";

/** The convention the two lists follow, named where a reader can check it. */
export const TIER_CONVENTION = "FTSE Russell equity country classification";

/** FTSE's 26 developed markets, less the United States. 25 by FTSE's own count, which
 * treats Belgium and Luxembourg as one market; listed separately here because a company
 * is domiciled in one or the other. */
const DEVELOPED_EX_US: ReadonlySet<string> = new Set([
  "AT", // Austria
  "AU", // Australia
  "BE", // Belgium
  "CA", // Canada
  "CH", // Switzerland
  "DE", // Germany
  "DK", // Denmark
  "ES", // Spain
  "FI", // Finland
  "FR", // France
  "GB", // United Kingdom
  "GR", // Greece — FTSE developed since 2026-09-21; MSCI follows in May 2027
  "HK", // Hong Kong
  "IE", // Ireland
  "IL", // Israel
  "IT", // Italy
  "JP", // Japan
  "KR", // South Korea — MSCI still calls this emerging
  "LU", // Luxembourg — a market to FTSE and S&P DJI, not to MSCI
  "NL", // Netherlands
  "NO", // Norway
  "NZ", // New Zealand
  "PL", // Poland — FTSE developed since 2018; MSCI still calls this emerging
  "PT", // Portugal
  "SE", // Sweden
  "SG", // Singapore
]);

/** FTSE's 23 emerging markets: 9 advanced emerging and 14 secondary, after Greece's
 * promotion and Vietnam's addition on 2026-09-21. */
const EMERGING: ReadonlySet<string> = new Set([
  "AE", // United Arab Emirates
  "BR", // Brazil
  "CL", // Chile
  "CO", // Colombia
  "CN", // China
  "CZ", // Czechia — the IMF calls this advanced
  "EG", // Egypt
  "HU", // Hungary
  "ID", // Indonesia
  "IN", // India
  "IS", // Iceland — MSCI calls this frontier
  "KW", // Kuwait
  "MX", // Mexico
  "MY", // Malaysia
  "PH", // Philippines
  "QA", // Qatar
  "RO", // Romania — MSCI calls this frontier
  "SA", // Saudi Arabia
  "TH", // Thailand
  "TR", // Türkiye
  "TW", // Taiwan — the IMF calls this advanced
  "VN", // Vietnam — MSCI calls this frontier
  "ZA", // South Africa
]);

/**
 * Offshore holding domiciles, assigned to the United States.
 *
 * These are places a company is registered, not places it operates or lists. The
 * operating business behind a Cayman or Bermuda registration is usually American and
 * the shares trade in New York, which is why FTSE's country-of-risk method lands on the
 * United States for the ones these funds hold. Assigning them anywhere else would put
 * a New York-listed company in a bucket its own index does not use.
 */
const OFFSHORE_HOLDCO: ReadonlySet<string> = new Set([
  "BM", // Bermuda
  "BS", // Bahamas
  "GG", // Guernsey
  "GI", // Gibraltar
  "IM", // Isle of Man
  "JE", // Jersey
  "KY", // Cayman Islands
  "MC", // Monaco
  "MH", // Marshall Islands
  "PA", // Panama
  "VG", // British Virgin Islands
]);

/** United States territories, which are the United States for a market split. */
const US_TERRITORY: ReadonlySet<string> = new Set([
  "PR", // Puerto Rico
]);

/**
 * European Union and EEA members that FTSE classifies as frontier and the IMF calls
 * advanced. They are in the single market and trade in Europe, so they are developed
 * ex-US here rather than emerging.
 */
const ADVANCED_FRONTIER: ReadonlySet<string> = new Set([
  "BG", // Bulgaria
  "CY", // Cyprus
  "EE", // Estonia
  "HR", // Croatia
  "LT", // Lithuania
  "LV", // Latvia
  "MT", // Malta
  "SI", // Slovenia
  "SK", // Slovakia
]);

/** The lists, exposed for the test that checks them against the published counts. */
export const TIER_SETS = {
  developedExUs: DEVELOPED_EX_US,
  emerging: EMERGING,
  offshoreHoldco: OFFSHORE_HOLDCO,
  usTerritory: US_TERRITORY,
  advancedFrontier: ADVANCED_FRONTIER,
} as const;

/**
 * The tier for a domicile, or `null` when there is no domicile to classify.
 *
 * Total over every ISO alpha-2 code: a code FTSE does not classify is placed by the
 * three rules in the header, so the Markets bar never has a fourth segment to draw.
 * `null` is reserved for "the release has no country for this company", which is a
 * different statement and is answered by the contested map, not by a default here.
 */
export function tierOf(country: string | null | undefined): CountryTier | null {
  if (!country) return null;
  // The release's codes are ISO-3166 alpha-2 upper case and hash-checked, so this is a
  // no-op on valid data. It is here because the residue rule below is total: without it
  // a lower-case "kr" would fall through to emerging and quietly put Korea in the wrong
  // bucket, which is the one failure mode a three-bucket table cannot show.
  const code = country.trim().toUpperCase();
  if (code === "US" || US_TERRITORY.has(code) || OFFSHORE_HOLDCO.has(code)) return "US";
  if (DEVELOPED_EX_US.has(code) || ADVANCED_FRONTIER.has(code)) return "DM";
  return "EM";
}
