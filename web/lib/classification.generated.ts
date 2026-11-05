// GENERATED FILE — do not edit by hand.
// Source: classification/classification.json
// Regenerate: python scripts/gen_classification.py

/** Which publisher's country classification a view is using. */
export type Provider = "MSCI" | "FTSE";

/** The provider's own tier for a domicile. */
export type MarketTier = "DEVELOPED" | "EMERGING" | "FRONTIER" | "STANDALONE" | "UNCLASSIFIED";

/** The three segments the Markets bar draws. */
export type CountryTier = "US" | "DM" | "EM";

/** The vintage of the classification below. */
export const TIER_AS_OF = "2026-11-05";

/** The provider a view uses when the reader has not chosen one. */
export const DEFAULT_PROVIDER: Provider = "MSCI";

/** Every provider, in the order the toggle shows them. */
export const PROVIDERS: readonly Provider[] = [
  "MSCI",
  "FTSE",
];

/** The name to print for a provider. */
export const PROVIDER_NAMES: Readonly<Record<Provider, string>> = {
  "MSCI": "MSCI",
  "FTSE": "FTSE Russell",
};

/** The attribution line a page prints beside the split. */
export const PROVIDER_LABELS: Readonly<Record<Provider, string>> = {
  "MSCI": "MSCI-aligned classification, maintained by UnpackFund",
  "FTSE": "FTSE Russell-aligned classification, maintained by UnpackFund",
};

/** Where a reader can check the provider's own published classification. */
export const PROVIDER_SOURCE_URLS: Readonly<Record<Provider, string>> = {
  "MSCI": "https://www.msci.com/our-solutions/indexes/market-classification",
  "FTSE": "https://www.lseg.com/en/ftse-russell/equity-country-classification",
};

/**
 * One row per `(provider, iso2, window)`: `[iso2, effective_from, effective_to, tier, label]`.
 * The window is `[from, to)`; `null` means still in force. Exported so the drift test can
 * compare it against the JSON rather than trusting a hash.
 */
export type ClassificationRow = readonly [string, string, string | null, MarketTier, string];

export const CLASSIFICATION_ROWS: Readonly<Record<Provider, readonly ClassificationRow[]>> = {
  "MSCI": [
    ["AE", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["AR", "1900-01-01", null, "STANDALONE", "Standalone Markets"],
    ["AT", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["AU", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["BD", "1900-01-01", null, "FRONTIER", "Frontier Markets"],
    ["BE", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["BG", "1900-01-01", "2027-06-01", "STANDALONE", "Standalone Markets"],
    ["BG", "2027-06-01", null, "FRONTIER", "Frontier Markets"],
    ["BH", "1900-01-01", null, "FRONTIER", "Frontier Markets"],
    ["BR", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["CA", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["CH", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["CL", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["CN", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["CO", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["CZ", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["DE", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["DK", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["EE", "1900-01-01", null, "FRONTIER", "Frontier Markets"],
    ["EG", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["ES", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["FI", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["FR", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["GB", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["GR", "1900-01-01", "2027-06-01", "EMERGING", "Emerging Markets"],
    ["GR", "2027-06-01", null, "DEVELOPED", "Developed Markets"],
    ["HK", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["HR", "1900-01-01", null, "FRONTIER", "Frontier Markets"],
    ["HU", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["ID", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["IE", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["IL", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["IN", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["IS", "1900-01-01", null, "FRONTIER", "Frontier Markets"],
    ["IT", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["JO", "1900-01-01", null, "FRONTIER", "Frontier Markets"],
    ["JP", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["KE", "1900-01-01", null, "FRONTIER", "Frontier Markets"],
    ["KR", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["KW", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["KZ", "1900-01-01", null, "FRONTIER", "Frontier Markets"],
    ["LK", "1900-01-01", null, "FRONTIER", "Frontier Markets"],
    ["LT", "1900-01-01", null, "FRONTIER", "Frontier Markets"],
    ["MA", "1900-01-01", null, "FRONTIER", "Frontier Markets"],
    ["MU", "1900-01-01", null, "FRONTIER", "Frontier Markets"],
    ["MX", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["MY", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["NG", "1900-01-01", null, "FRONTIER", "Frontier Markets"],
    ["NL", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["NO", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["NZ", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["OM", "1900-01-01", null, "FRONTIER", "Frontier Markets"],
    ["PE", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["PH", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["PK", "1900-01-01", null, "FRONTIER", "Frontier Markets"],
    ["PL", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["PT", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["QA", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["RO", "1900-01-01", null, "FRONTIER", "Frontier Markets"],
    ["RS", "1900-01-01", null, "FRONTIER", "Frontier Markets"],
    ["SA", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["SE", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["SG", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["SI", "1900-01-01", null, "FRONTIER", "Frontier Markets"],
    ["TH", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["TN", "1900-01-01", null, "FRONTIER", "Frontier Markets"],
    ["TR", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["TW", "1900-01-01", null, "EMERGING", "Emerging Markets"],
    ["US", "1900-01-01", null, "DEVELOPED", "Developed Markets"],
    ["VN", "1900-01-01", null, "FRONTIER", "Frontier Markets"],
    ["ZA", "1900-01-01", null, "EMERGING", "Emerging Markets"],
  ],
  "FTSE": [
    ["AE", "1900-01-01", null, "EMERGING", "Emerging"],
    ["AT", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["AU", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["BD", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["BE", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["BG", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["BH", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["BR", "1900-01-01", null, "EMERGING", "Emerging"],
    ["CA", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["CH", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["CL", "1900-01-01", null, "EMERGING", "Emerging"],
    ["CN", "1900-01-01", null, "EMERGING", "Emerging"],
    ["CO", "1900-01-01", null, "EMERGING", "Emerging"],
    ["CY", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["CZ", "1900-01-01", null, "EMERGING", "Emerging"],
    ["DE", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["DK", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["EE", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["EG", "1900-01-01", null, "EMERGING", "Emerging"],
    ["ES", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["FI", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["FR", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["GB", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["GR", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["HK", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["HR", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["HU", "1900-01-01", null, "EMERGING", "Emerging"],
    ["ID", "1900-01-01", null, "EMERGING", "Emerging"],
    ["IE", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["IL", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["IN", "1900-01-01", null, "EMERGING", "Emerging"],
    ["IS", "1900-01-01", null, "EMERGING", "Emerging"],
    ["IT", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["JO", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["JP", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["KE", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["KR", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["KW", "1900-01-01", null, "EMERGING", "Emerging"],
    ["KZ", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["LK", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["LT", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["LU", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["LV", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["MA", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["MT", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["MU", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["MX", "1900-01-01", null, "EMERGING", "Emerging"],
    ["MY", "1900-01-01", null, "EMERGING", "Emerging"],
    ["NG", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["NL", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["NO", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["NZ", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["OM", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["PA", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["PE", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["PH", "1900-01-01", null, "EMERGING", "Emerging"],
    ["PK", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["PL", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["PT", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["QA", "1900-01-01", null, "EMERGING", "Emerging"],
    ["RO", "1900-01-01", null, "EMERGING", "Emerging"],
    ["RS", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["SA", "1900-01-01", null, "EMERGING", "Emerging"],
    ["SE", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["SG", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["SI", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["SK", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["TH", "1900-01-01", null, "EMERGING", "Emerging"],
    ["TN", "1900-01-01", null, "FRONTIER", "Frontier"],
    ["TR", "1900-01-01", null, "EMERGING", "Emerging"],
    ["TW", "1900-01-01", null, "EMERGING", "Emerging"],
    ["US", "1900-01-01", null, "DEVELOPED", "Developed"],
    ["VN", "1900-01-01", null, "EMERGING", "Emerging"],
    ["ZA", "1900-01-01", null, "EMERGING", "Emerging"],
  ],
};

/** How a tier folds into the bar's three segments. */
export const TIER_FOLD: Readonly<Record<MarketTier, CountryTier>> = {
  "DEVELOPED": "DM",
  "EMERGING": "EM",
  "FRONTIER": "EM",
  "STANDALONE": "EM",
  "UNCLASSIFIED": "EM",
};

/**
 * Domiciles the provider does not classify, placed by a stated product rule.
 * `shared` applies to every provider; `byProvider` overrides it for one.
 */
export const SHARED_BUCKETS: Readonly<Record<string, CountryTier>> = {
  "BM": "US",
  "BS": "US",
  "GG": "US",
  "GI": "US",
  "IM": "US",
  "JE": "US",
  "KY": "US",
  "MC": "US",
  "MH": "US",
  "PA": "US",
  "PR": "US",
  "US": "US",
  "VG": "US",
};

export const PROVIDER_BUCKETS: Readonly<Record<Provider, Readonly<Record<string, CountryTier>>>> = {
  "MSCI": {
    "LU": "DM",
  },
  "FTSE": {
    "BG": "DM",
    "CY": "DM",
    "EE": "DM",
    "HR": "DM",
    "LT": "DM",
    "LV": "DM",
    "MT": "DM",
    "SI": "DM",
    "SK": "DM",
  },
};

export interface TierOptions {
  /** Defaults to `DEFAULT_PROVIDER`. */
  provider?: Provider;
  /** Defaults to `TIER_AS_OF`. The window is `[from, to)`. */
  asOf?: string;
}

const BY_PROVIDER: Readonly<Record<Provider, ReadonlyMap<string, readonly ClassificationRow[]>>> =
  Object.fromEntries(
    PROVIDERS.map((provider) => {
      const index = new Map<string, ClassificationRow[]>();
      for (const row of CLASSIFICATION_ROWS[provider]) {
        const rows = index.get(row[0]);
        if (rows) rows.push(row);
        else index.set(row[0], [row]);
      }
      return [provider, index];
    }),
  ) as Readonly<Record<Provider, ReadonlyMap<string, readonly ClassificationRow[]>>>;

/**
 * The provider's tier for a domicile, or `null` when there is no domicile to classify.
 *
 * `null` is reserved for "the release has no country for this company", which is a
 * different statement and is answered by the release's contested map, not by a default
 * here. A code the provider does not classify is `UNCLASSIFIED`, which is a tier.
 */
export function marketTierOf(
  country: string | null | undefined,
  options: TierOptions = {},
): MarketTier | null {
  if (!country) return null;
  const code = country.trim().toUpperCase();
  if (!code) return null;
  const provider = options.provider ?? DEFAULT_PROVIDER;
  const asOf = options.asOf ?? TIER_AS_OF;
  const rows = BY_PROVIDER[provider].get(code);
  if (!rows) return "UNCLASSIFIED";
  for (const row of rows) {
    if (row[1] <= asOf && (row[2] === null || asOf < row[2])) return row[3];
  }
  return "UNCLASSIFIED";
}

/**
 * The bar's three segments for a domicile, or `null` when there is no domicile.
 *
 * Total over every ISO alpha-2 code: a domicile the provider does not classify is
 * placed by a stated rule, so the Markets bar never has a fourth segment to draw.
 */
export function tierOf(
  country: string | null | undefined,
  options: TierOptions = {},
): CountryTier | null {
  if (!country) return null;
  const code = country.trim().toUpperCase();
  if (!code) return null;
  const provider = options.provider ?? DEFAULT_PROVIDER;
  const shared = SHARED_BUCKETS[code];
  if (shared) return shared;
  const override = PROVIDER_BUCKETS[provider][code];
  if (override) return override;
  const tier = marketTierOf(code, { provider, asOf: options.asOf });
  return tier === null ? null : TIER_FOLD[tier];
}
