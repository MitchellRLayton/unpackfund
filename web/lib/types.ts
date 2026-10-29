/**
 * The wire format, as the pipeline writes it (schema v1).
 *
 * These types mirror `pipeline/pipeline/artifact.py` and `manifest.py`; the
 * contract that governs them is `data-contract-and-release` §1 and §5. Nothing
 * here is invented for the UI: if a field is absent, the display says so rather
 * than filling the gap.
 */

/** Fund documents: unchanged since day 1. */
export const SCHEMA_VERSION = 1;

/**
 * The release descriptor, which is what the pointer publishes.
 *
 * Day 4's pointer was the full inventory: 8,533 file entries, 1.29 MB raw, and the
 * app downloaded it before it could verify one fund. It now carries the header plus
 * a description of the objects beside it, and the inventory (`manifest.json`) stays
 * in the release for audits. Version 2 is that change and nothing else.
 */
export const RELEASE_SCHEMA_VERSION = 2;

/** One published object, as the descriptor names it. */
export interface ObjectDescriptor {
  path: string;
  bytes: number;
  sha256: string;
}

/** `latest/manifest.json`, and byte-identically `releases/{as_of}/release.json`. */
export interface ReleaseDescriptor {
  schema_version: number;
  kind: "release";
  /** Release stamp, e.g. `2026-10-30.1`. Also the directory name. */
  as_of: string;
  generated_at: string;
  pipeline_git_sha: string;
  fund_count: number;
  /** `null` until a share-class classifier exists; a zero would be wrong. */
  etf_count: number | null;
  etf_classifier: string | null;
  company_count: number;
  coverage_histogram: Record<string, number>;
  mapping_rungs: Record<string, number>;
  asset_cat_counts: Record<string, number>;
  objects: {
    /** The full inventory; nothing in the app reads it. */
    manifest: ObjectDescriptor;
    tickers: ObjectDescriptor;
    catalogue: ObjectDescriptor;
    fund_index: { prefix: string; shards: string[]; funds: number };
    companies: { index: ObjectDescriptor; prefix: string; count: number };
    /**
     * Share-class tickers, optional because a release built before the alias map
     * existed is still a valid release: the app degrades to "unknown ticker"
     * rather than refusing to open.
     */
    aliases?: { object: ObjectDescriptor; count: number };
  };
}

/** `releases/{as_of}/tickers.json` — the builder's whole catalogue need. */
export interface TickerList {
  as_of: string;
  tickers: string[];
}

/** `releases/{as_of}/index/{L}.json` — what a fund is verified against. */
export interface FundIndexShard {
  as_of: string;
  funds: Record<string, { bytes: number; sha256: string }>;
}

/**
 * `releases/{as_of}/catalogue.json`, positional on purpose: 8,531 of them is
 * 470 KB as arrays and 940 KB as objects. Order is `[name, issuer, etf, coverage]`.
 */
export type CatalogueRow = [
  name: string,
  issuer: string,
  etf: number,
  coveragePct: number,
];

export interface Catalogue {
  as_of: string;
  /** The name of the test behind every `etf` flag, so the label is not a mystery. */
  etf_classifier?: string;
  funds: Record<string, CatalogueRow>;
}

/**
 * `releases/{as_of}/aliases.json` — a share-class ticker to the published ticker
 * of the same portfolio. A fund is one portfolio with many classes (VOO, VFIAX,
 * VFINX), and the release publishes one file per portfolio, so this is the map
 * that turns "the ticker I actually own" into a page that exists.
 */
export interface FundAliases {
  as_of: string;
  /** alias ticker → published ticker */
  targets: Record<string, string>;
}

/** One row of the company index: `[company_id, name, ticker, holder_count]`. */
export type CompanyIndexRow = [string, string, string | null, number];

/** `releases/{as_of}/companies/index.json` — every company, for search. */
export interface CompanyIndex {
  as_of: string;
  companies: CompanyIndexRow[];
}

/** `releases/{as_of}/companies/{company_id}.json` — the reverse X-Ray payload. */
export interface CompanyShard {
  as_of: string;
  company_id: string;
  name: string;
  ticker: string | null;
  /** `[ticker, weight_bp]`, the fund's own weight for this company. */
  funds: Array<[string, number]>;
}

export type AssetCategory = "equity" | "debt" | "cash" | "derivative" | "fund" | "other";

/** One N-PORT line, after mapping. `company_id` is `null` when unresolved. */
export interface Holding {
  company_id: string | null;
  name: string;
  ticker: string | null;
  asset_cat: AssetCategory;
  /** Integer basis points of the fund's filed NAV, never renormalised. */
  weight_bp: number;
}

export interface FundMetrics {
  hhi: number;
  hhi_pct2: number;
  effective_n: number;
  top10_pct: number;
}

export type WarningCode =
  | "partial_coverage"
  | "unmapped_holding"
  | "cash_or_derivative"
  | "stale_filing"
  | "duplicate_company"
  | "negative_weight"
  | "fund_of_funds";

/** `releases/{as_of}/funds/{TICKER}.json`. */
export interface FundDocument {
  schema_version: number;
  ticker: string;
  fund_id: string;
  name: string;
  issuer: string;
  /** End of the N-PORT reporting period, not today. */
  as_of: string;
  filed_at: string;
  lag_days: number;
  source: string;
  source_url: string;
  /** Weight-based resolution percentage; the same number as the 60/70 bands. */
  coverage_pct: number;
  holdings: Holding[];
  metrics: FundMetrics;
  warnings: WarningCode[];
}

/** A portfolio entry: the user's allocation to one fund, in basis points. */
export interface PortfolioEntry {
  ticker: string;
  weight_bp: number;
}

/** The complete portfolio state, which is what the URL fragment encodes. */
export interface Portfolio {
  entries: PortfolioEntry[];
}

/** `Σ weight_bp` for a portfolio whose weights are fully allocated. */
export const FULL_ALLOCATION_BP = 10_000;

/**
 * One company line in the ledger: the portfolio-level look-through weight.
 *
 * `weight` is a fraction of the portfolio, not of any fund, and not basis points
 * — it is the sum of `W_k · w_{i,k}` from the math skill §1, converted once here.
 */
export interface LedgerRow {
  company_id: string;
  name: string;
  ticker: string | null;
  /** Fraction of the whole portfolio. */
  weight: number;
  /** How many of the portfolio's funds hold it. */
  fund_count: number;
  /** Per-fund contribution, largest first, for the ledger's second line. */
  sources: Array<{ ticker: string; weight: number }>;
}

/** Portfolio-level aggregates. A null metric is "not computable", never zero. */
export interface LedgerMetrics {
  /** Fraction. `Σ wᵢ²` over positive ledger weights. */
  hhi: number | null;
  effective_n: number | null;
  /** Fraction of portfolio weight in the ten largest companies. */
  top10: number | null;
  /** Weight-weighted mean of each fund's `coverage_pct`. */
  covered_weight_pct: number;
  /** Portfolio weight that resolved to a company, as a fraction. */
  resolved_weight: number;
  /** Portfolio weight in funds whose coverage band suppresses metrics. */
  suppressed_weight: number;
}

export interface Ledger {
  rows: LedgerRow[];
  metrics: LedgerMetrics;
  /** Funds that contributed, in the order the portfolio lists them. */
  funds: Array<
    Pick<
      FundDocument,
      | "ticker"
      | "name"
      | "as_of"
      | "filed_at"
      | "lag_days"
      | "coverage_pct"
      | "source_url"
    >
  >;
  /** Oldest filing period in the portfolio, for the freshness strip. */
  oldest_as_of: string | null;
  /** Largest `lag_days`, for the freshness strip. */
  max_lag_days: number | null;
  /** Holdings dropped because they have no `company_id`. */
  unmapped_holdings: number;
}
