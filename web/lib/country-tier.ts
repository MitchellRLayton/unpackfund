/**
 * Which market a domicile belongs to.
 *
 * The ledger's left edge answers one question — is this company American, developed
 * ex-US, or emerging? — and the answer is a *convention*, not a fact about the world.
 * Three respected publishers disagree about nine countries (Korea, Taiwan, Poland,
 * Greece, Peru, Iceland, Romania, Vietnam, Luxembourg), so a table with no stated
 * convention is a guess wearing a claim's clothes.
 *
 * **The convention is FTSE Russell's equity country classification, as of 2026-11-02.**
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
 * `OTHER` is the honest fourth bucket: a domicile that neither provider calls developed
 * or emerging, or one with no market classification at all. It covers 4.2% of the
 * companies in the 2026-11-02.7 release, most of them offshore holding domiciles —
 * Cayman (KY, 230 companies), Bermuda (BM, 48), the British Virgin Islands (VG),
 * Guernsey (GG), Jersey (JE), the Isle of Man (IM), Panama (PA) — plus Argentina,
 * Russia, Puerto Rico and Liechtenstein. Rendering those as emerging would be a
 * fabrication, and rendering them with no edge at all would make them indistinguishable
 * from a company whose filings disagree, so the row keeps its country code and loses
 * only the colour.
 *
 * Changing this table is a dated change: update `TIER_AS_OF`, record it in the build
 * log, and let `country-tier.test.ts` (counts, disjointness, spot checks) and
 * `theme.test.ts` (three distinguishable inks) run before it ships.
 */

export type CountryTier = "US" | "DM" | "EM" | "OTHER";

/** The vintage of the classification below. A code with a newer provider release is not covered. */
export const TIER_AS_OF = "2026-11-02";

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

/** The two lists, exposed for the test that checks them against the published counts. */
export const TIER_SETS = {
  developedExUs: DEVELOPED_EX_US,
  emerging: EMERGING,
} as const;

/**
 * The tier for a domicile. Anything the release does not classify as American, developed
 * or emerging is `OTHER` — never `EM`, and never a guess: an unlisted code is a code this
 * table has no opinion about, which is what `OTHER` says.
 */
export function tierOf(country: string | null | undefined): CountryTier {
  if (!country) return "OTHER";
  if (country === "US") return "US";
  if (DEVELOPED_EX_US.has(country)) return "DM";
  if (EMERGING.has(country)) return "EM";
  return "OTHER";
}
