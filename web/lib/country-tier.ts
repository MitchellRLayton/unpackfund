/**
 * Which market a domicile belongs to.
 *
 * The ledger's left edge answers one question — is this company American, developed
 * ex-US, or emerging? — and the answer is a *convention*, not a fact about the world.
 * Two respected publishers disagree about nine countries, so a table with no stated
 * convention is a guess wearing a claim's clothes.
 *
 * **The default convention is MSCI's, as of 2026-11-05.** Chosen because it is what the
 * funds this site looks through actually benchmark to: iShares, Avantis and Dimensional
 * all track MSCI indexes, so "emerging" here means what it means on the fund's own page.
 * Vanguard is the FTSE exception, and FTSE is one click away — see `Provider`.
 *
 * The table itself lives in `classification/classification.json` and is generated into
 * `classification.generated.ts` by `scripts/gen_classification.py`. This module is the
 * stable surface the rest of the app imports, so a caller never has to know that the
 * data moved: `tierOf(country)` still returns `"US" | "DM" | "EM" | null`, and the
 * provider and the vintage are optional second arguments.
 *
 * ## Three segments, five tiers
 *
 * The Markets bar draws exactly three segments — United States, International Developed
 * ex-US, Emerging Markets — because that is the split a reader compares against an
 * issuer's own factsheet, and a fourth "no market tier" segment is a question the page
 * cannot answer rather than an answer. The provider's own tier is still available from
 * `marketTierOf`, and the country table prints it, so a reader sees `Frontier` beside
 * Vietnam without a fourth segment being drawn.
 *
 * Frontier and Standalone fold into Emerging. A three-bucket view has no fourth place
 * for them, and frontier is closer to emerging than to either of the other two.
 *
 * ## Where a domicile the provider does not classify goes
 *
 * Two stated product rules, in `classification.json` under `bucket_rules`, applied
 * before the tier is consulted:
 *
 * - **Offshore holding domiciles are the United States.** Bermuda, the Cayman Islands,
 *   the British Virgin Islands, Jersey, Guernsey, the Isle of Man, the Marshall Islands,
 *   Panama, the Bahamas, Gibraltar and Monaco are where a company is *registered*, not
 *   where it operates: most of the weight in them is an American business listed in New
 *   York. The minority this gets wrong — Chinese operating businesses registered in
 *   Cayman — is corrected by `pipeline/overrides/country_overrides.csv`, which is
 *   applied in the pipeline and published in the release, not here.
 * - **Puerto Rico is the United States**, because it is a United States territory.
 *
 * `null` in, `null` out: a company the release declines to place has no tier, and
 * `null` is how that is said. It is never defaulted to a bucket — the Markets bar places
 * such a company from the release's *contested* map instead, which is a different
 * question with its own stated rule.
 *
 * Changing the table is a dated change: edit `classification/classification.json`, run
 * `python scripts/gen_classification.py`, and let `country-tier.test.ts` (counts,
 * disjointness, spot checks, the FTSE regression) run before it ships.
 */

export {
  CLASSIFICATION_ROWS,
  DEFAULT_PROVIDER,
  PROVIDER_BUCKETS,
  PROVIDER_LABELS,
  PROVIDER_NAMES,
  PROVIDER_SOURCE_URLS,
  PROVIDERS,
  SHARED_BUCKETS,
  TIER_AS_OF,
  TIER_FOLD,
  marketTierOf,
  tierOf,
} from "./classification.generated";

export type {
  ClassificationRow,
  CountryTier,
  MarketTier,
  Provider,
  TierOptions,
} from "./classification.generated";

import {
  DEFAULT_PROVIDER,
  PROVIDER_NAMES,
  TIER_AS_OF,
  type Provider,
} from "./classification.generated";

/**
 * The convention the table follows, named where a reader can check it.
 *
 * Kept as a string for copy that has no provider in scope; prefer
 * `tierConvention(provider)` where the reader has chosen one.
 */
export const TIER_CONVENTION = `${PROVIDER_NAMES[DEFAULT_PROVIDER]}-aligned country classification`;

/** The convention for a named provider, for copy that knows which one is on screen. */
export function tierConvention(provider: Provider = DEFAULT_PROVIDER): string {
  return `${PROVIDER_NAMES[provider]}-aligned country classification`;
}

/** The vintage, as a phrase a page can print beside the split. */
export const TIER_ATTRIBUTION = `as of ${TIER_AS_OF}`;
