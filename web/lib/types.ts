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
  /**
   * The release's own identification share: weight whose security is known, whether or
   * not a company was attributed to it. Additive and optional — a release published
   * before the pipeline measured it carries no such key, and the app then shows the
   * attributed figure alone rather than a zero or a guess.
   */
  identified_pct?: number | null;
  identified_bp?: number | null;
  total_bp?: number | null;
  identified_by_cat?: Record<AssetCategory, number | null>;
  mapping_rungs: Record<string, number>;
  asset_cat_counts: Record<string, number>;
  objects: {
    /** The full inventory; nothing in the app reads it. */
    manifest: ObjectDescriptor;
    tickers: ObjectDescriptor;
    catalogue: ObjectDescriptor;
    fund_index: { prefix: string; shards: string[]; funds: number };
    companies: {
      index: ObjectDescriptor;
      prefix: string;
      count: number;
      /**
       * The company→country map. Optional, and its absence is a valid release: every
       * release published before `2026-11-02.6` carries no country object at all, and
       * the ledger then shows no tag, no edge, and no caption sentence rather than a
       * default or an error.
       */
      countries?: ObjectDescriptor;
    };
    /**
     * Share-class tickers, optional because a release built before the alias map
     * existed is still a valid release: the app degrades to "unknown ticker"
     * rather than refusing to open.
     */
    aliases?: { object: ObjectDescriptor; count: number };
    /**
     * The compact benchmark rollups this release pre-rolled (`benchmarks/{T}.json`).
     * Optional for the same reason as `aliases`, and load-bearing here: a release
     * that predates the object makes the app fall back to the benchmark's full fund
     * document, which is slower but identical. Presence, not a version number, is
     * the switch — that is what lets the bundle ship before the data does.
     */
    benchmarks?: { prefix: string; files: Record<string, ObjectDescriptor> };
    /**
     * The typed-symbol object (ADR-0014), optional for the same reason `aliases` is:
     * a release built before it existed stays loadable, and the builder then
     * refuses a stock ticker with "not in this release" rather than breaking.
     */
    securities?: {
      prefix: string;
      /** Shard letter → the object it names, so the fetched bytes are verified. */
      shards: Record<string, ObjectDescriptor>;
      count: number;
      /** How many symbols carry each status, so a refusal rate is visible. */
      statuses: Record<string, number>;
    };
  };
}

/**
 * `releases/{as_of}/securities/{L}.json` — a typed stock ticker's identity.
 *
 * Four fields per symbol, positional: `[company_id, name, exchange, status]`. The
 * status is the acceptance verdict computed at build time; `"ok"` is the only one
 * the app may add to a portfolio, and every other value carries the reason the
 * refusal names (`pipeline/securities.py`).
 */
export interface SecuritiesShard {
  as_of: string;
  source_url: string;
  securities: Record<string, SecuritiesRow>;
}

export type SecuritiesRow = [
  companyId: string,
  name: string,
  exchange: string | null,
  status: SecurityStatus,
];

/** `ok` is accepted; the rest are refusals with a reason the UI turns into words. */
export type SecurityStatus = "ok" | "fund" | "pfd" | "wnt" | "unit" | "rgt" | "twin";

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
/**
 * One positional `catalogue.json` row: `[name, issuer, etf, coverage_pct]` and, from a
 * release built after 2026-11-02, the fund's own filed net assets as a fifth element.
 *
 * The fifth is optional because the app points at whichever release is live, and the
 * live one may predate the field: a reader must not break on an older release, and the
 * pipeline's validator accepts both row lengths for the same reason (the additive
 * contract, `data-contract-and-release`).
 */
export type CatalogueRow = [
  name: string,
  issuer: string,
  etf: number,
  coveragePct: number,
  netAssets?: number | null,
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

/**
 * `company_id` carries **two namespaces**, and every consumer must treat the id as
 * opaque because of it:
 *
 * - `c_` + 10 digits — an SEC operating company, keyed by CIK. Every row the EDGAR
 *   ladder resolved.
 * - `l_` + 16 hex — a GLEIF-registered legal entity, keyed by a hash of the issuer's
 *   LEI. Foreign issuers file no N-PORT and have no CIK, so without this namespace
 *   96.6% of the international holdings had no identity at all (2026-10-30).
 *
 * Nothing in the app may assume an id is a CIK, and nothing may compare a CIK to an
 * LEI: the two namespaces are parallel, and a fund share never becomes an issuer.
 */
export const COMPANY_ID_PATTERN = /^(?:c_\d{10}|l_[0-9a-f]{16})$/;

/** True for a well-formed `company_id` in either namespace. */
export function isCompanyId(value: string | null | undefined): value is string {
  return typeof value === "string" && COMPANY_ID_PATTERN.test(value);
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
  /**
   * The domicile this company's holders' filings agree on, or `null` when they do not.
   * Additive, so a shard from a release before the field existed is still readable; the
   * ledger does not read it (it has its own map), and `/c` will.
   */
  country?: string | null;
  /** `[ticker, weight_bp]`, the fund's own weight for this company. */
  funds: Array<[string, number]>;
}

/**
 * `releases/{as_of}/companies/countries.json` — one country code per company.
 *
 * A **lookup, never a computation**: the code is decided once by the pipeline, and the
 * browser only reads the row it needs. A company that is absent from `companies` is one
 * the filings disagree about, or one held only by funds that file no country — the
 * honest no-answer, which renders as no tag rather than as a guess or a default
 * (`data-contract-and-release` §5).
 */
export interface CompanyCountries {
  schema_version: number;
  kind: "company_countries";
  /** The release stamp this map belongs to, e.g. `2026-11-02.6`. */
  as_of: string;
  /** Where the codes came from, in words — `SEC N-PORT invCountry`. */
  source: string;
  /** The rule that decided an answer, in words: the majority threshold, not a guess. */
  rule: string;
  /** `company_id` → ISO-3166-1 alpha-2, uppercase. Absence means "no answer". */
  companies: Record<string, string>;
  /**
   * `company_id` → the country holding the largest share of the money in it, for a
   * company the vote could not decide. A **second, weaker answer to a different
   * question**, published beside the first and never merged into it: the company tag
   * keeps "we decline to place it", and the Markets bar gets a bucket.
   *
   * Disjoint from `companies` by construction (the validator refuses an overlap).
   * Absent on every release published before 2026-11-05.
   */
  contested?: Record<string, string>;
  /** The rule behind `contested`, in words, so the weaker answer states its own bar. */
  contested_rule?: string;
  /** How many companies got an answer, so coverage is statable rather than implied. */
  counts: {
    companies: number;
    with_country: number;
    us: number;
    non_us: number;
    undecided: number;
  };
}

/**
 * The two country answers a release publishes, as the app reads them.
 *
 * `companies` is the decided map and is what a company tag renders. `contested` is the
 * weaker second answer for a company the vote could not decide, and only the Markets
 * bar reads it — keeping them in one object makes it obvious at every call site which
 * question is being asked.
 */
export interface CompanyCountryMaps {
  companies: Record<string, string>;
  contested: Record<string, string>;
}

export type AssetCategory = "equity" | "debt" | "cash" | "derivative" | "fund" | "other";

/**
 * A position the visitor holds directly, resolved to the company the funds already
 * use and weighted as a fraction of the whole portfolio.
 *
 * It is not a `Holding`: a holding is a *filing's* row with its own basis points of
 * that fund's NAV, and pretending a typed symbol were one is what the rejected
 * "degenerate fund document" encoding did — it fabricates a filing date and a
 * coverage percentage that no filing asserted (ADR-0014).
 */
export interface DirectHolding {
  company_id: string;
  /** The registered SEC title, as the confirmation step showed it. */
  name: string;
  /** The symbol the visitor typed, normalised (`BRK.B` → `BRK-B`). */
  ticker: string;
  /** Fraction of the whole portfolio. */
  weight: number;
}

/** One N-PORT line, after mapping. `company_id` is `null` when unresolved. */
export interface Holding {
  company_id: string | null;
  name: string;
  ticker: string | null;
  asset_cat: AssetCategory;
  /** Integer basis points of the fund's filed NAV, never renormalised. */
  weight_bp: number;
  /**
   * Whether the filing's own security identifier for this row resolved to a known
   * security — the weaker test that `identified_pct` aggregates. Optional: absent on
   * every release published before the field existed, and `false` is not a claim that
   * the row is unknown, only that nothing identified it.
   */
  identified?: boolean;
  /**
   * The filing's own `invCountry` for this position, published **only** on a row that
   * resolved to no company — the one case where the release has no better answer.
   *
   * It is not the company's domicile: that is decided once, by value, across every fund
   * that holds the company, and a row with a `company_id` must be read from
   * `companies/countries.json` instead. The field exists so the Markets bar can place a
   * position the identity ladder could not name, rather than drawing it as weight with
   * no market. Absent on every release published before 2026-11-05.
   */
  filed_country?: string;
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
  | "fund_of_funds"
  | "fund_of_funds_unresolved";

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
  /**
   * What the fund is made of, in integer basis points, always all six keys and always
   * summing to the holding total. This is the "60/40" fact: AOR publishes
   * `{equity: 6054, debt: 3709, …}` before any question about coverage (ADR-0016).
   * Optional because the field is additive: a document from a release before
   * `2026-11-02.3` does not carry it, and a reader must not assume otherwise.
   */
  categories?: Record<AssetCategory, number>;
  /**
   * Coverage measured *inside* each asset class — the only coverage number that can be
   * compared to another fund's. The headline `coverage_pct` blends populations with
   * different ceilings (a debt row only maps when its issuer is a corporate issuer,
   * cash never), so a 30/70 fund reads 49.5% while its equity sleeve is 99.7% mapped.
   * `null` for a class the fund does not hold: a percentage of nothing is undefined.
   * Optional for the same reason as `categories`.
   */
  coverage_by_cat?: Record<AssetCategory, number | null>;
  /**
   * The fund's identification share: 100 × (weight whose security is known) ÷ gross.
   * Always at least `coverage_pct`, because attribution to a company is the stricter
   * test: a row can be a known security with no company behind it (a Treasury, a repo,
   * a registered fund). Optional for the same reason as `categories` — a document from
   * an earlier release carries no such key, and the page then shows one number, not two.
   */
  identified_pct?: number | null;
  /** The same two shares per asset class, the counterpart of `coverage_by_cat`. */
  identified_by_cat?: Record<AssetCategory, number | null>;
  holdings: Holding[];
  metrics: FundMetrics;
  warnings: WarningCode[];
  /**
   * The sleeve view of a fund-of-funds: the registered funds it holds, at their
   * weights. Present on any fund that holds funds, whether or not its own vector
   * could be flattened — a `ticker` of `null` means the position could not be
   * matched to a fund we publish, so it stays named but unexplained.
   */
  components?: FundComponent[];
  /**
   * Present only when `holdings`, `coverage_pct` and `metrics` are the *composed*
   * vector rather than the as-filed one. Presence is the marker: there is no
   * separate flag, and a reader that ignores this field still reads one coherent
   * portfolio, because the composed vector replaces `holdings` instead of sitting
   * beside it.
   */
  lookthrough?: FundLookthrough;
}

/** One sleeve of a fund-of-funds, as filed and as resolved. */
export interface FundComponent {
  /** The fund we publish for this sleeve, or `null` when it could not be matched. */
  ticker: string | null;
  name: string;
  weight_bp: number;
  /** The sleeve's own coverage, so a composed weight carries its uncertainty. */
  coverage_pct: number | null;
  /**
   * What the sleeve holds, from its own published split: its largest class, or `mixed`
   * when equity and debt are each at least 20% of it. `null` when the sleeve could not
   * be matched to a fund we publish — we do not know what it holds, so a label would be
   * a guess (ADR-0016 §4).
   */
  asset_cat?: AssetCategory | "mixed" | null;
  resolved_by: "series_lei" | "share_class_symbol" | null;
}

/** Provenance for a composed vector: every weight in `holdings` follows from it. */
export interface FundLookthrough {
  /** Hops to the terminal companies; 1 is a plain fund-of-funds. */
  depth: number;
  /** Weight in registered funds, in this fund's basis points. */
  fund_bp: number;
  /** Of that, the part that was expanded into the sleeves' own holdings. */
  resolved_fund_bp: number;
  /** The rest: an unresolved sleeve, a cycle, or a sleeve past the hop cap. */
  unresolved_fund_bp: number;
  /** Largest difference between a sleeve's period end and this fund's, in days. */
  as_of_skew_days: number;
  /** Sum of the published vector, so a reader can check it closes to NAV. */
  holdings_bp: number;
  /** Sleeves that could not be expanded, counted by cause. */
  refused: Record<string, number>;
}

/**
 * What a portfolio entry is: a fund, a stock the visitor holds directly, or cash.
 *
 * The three are one type because they are one list — a portfolio is a set of
 * allocations, and the ledger has to see all of them to answer "what do I own".
 * They are not interchangeable downstream: a fund contributes its filing's
 * holdings, a security contributes itself, and cash contributes nothing but is
 * still part of the visitor's money (`lookthrough-math-and-qa` §3).
 */
export type EntryKind = "fund" | "security" | "cash";

/**
 * How the visitor typed their amounts.
 *
 * `bp` = percentages, stored as integer basis points, and the entries must total
 * exactly 10,000 to be a portfolio at all — an unallocated remainder is refused,
 * not guessed at. `usd` = dollars, stored as integer **cents**, and the total is
 * whatever their amounts add up to: the weights are `cents / Σ cents`.
 *
 * The mode is part of the URL because a shared link must reproduce the numbers the
 * visitor typed, not a re-normalised version of them.
 */
export type EntryMode = "bp" | "usd";

/**
 * One portfolio entry.
 *
 * `amount` is basis points in `bp` mode and cents in `usd` mode — never both, and
 * never a fraction. The conversion to a fraction happens once, at the edge, in
 * `portfolio-weights.ts`; everything downstream (the ledger, the metrics) works in
 * fractions of the whole portfolio.
 */
export interface PortfolioEntry {
  kind: EntryKind;
  /** Fund ticker, security symbol, or `CASH`. */
  key: string;
  amount: number;
}

/** The complete portfolio state, which is what the URL fragment encodes. */
export interface Portfolio {
  mode: EntryMode;
  entries: PortfolioEntry[];
}

/** The key a cash entry uses; not a ticker, so it can never collide with one. */
export const CASH_KEY = "CASH";

/**
 * A fund and a basis-point weight — the shape `/compare` has always used, and still
 * does. The comparison surface is funds-only by design: overlap between two
 * *stock* positions is either 100% (same company) or 0%, which needs no chart.
 */
export interface FundWeight {
  ticker: string;
  weight_bp: number;
}

/** `Σ weight_bp` for a portfolio whose weights are fully allocated. */
export const FULL_ALLOCATION_BP = 10_000;

/**
 * The benchmark's per-company weights, and everything needed to label them.
 *
 * There is one benchmark at a time ([ADR-0015](../../../docs/04-decisions/ADR-0015-vt-benchmark.md),
 * amended 2026-11-11): VT is the default and the reader may pick one of five published
 * funds from the Companies lens, so the payload is whichever fund's weights the ledger
 * was built with. It is built by `benchmarkFor` and travels to the worker in place of
 * the fund document, because the aggregation needs the weights and the caption needs the
 * provenance — not 9,700 holdings.
 *
 * `weights` is keyed by `company_id` and holds **fractions of the benchmark's own
 * NAV**: the fund's weight in that company, never the visitor's. A company absent
 * from the map is one the benchmark's traced holdings do not include — which the
 * column renders as `0.00%` and the caption qualifies with `coverage_pct`.
 */
export interface BenchmarkComparison {
  ticker: string;
  name: string;
  as_of: string;
  filed_at: string;
  lag_days: number;
  /** Share of the benchmark's NAV its own filing attributes to a company. */
  coverage_pct: number;
  source_url: string;
  /** `company_id` → share of the benchmark's NAV, as a fraction. */
  weights: Record<string, number>;
}

/**
 * `releases/{as_of}/benchmarks/{TICKER}.json` — one benchmark's weights, pre-rolled.
 *
 * The fund document is 1.58 MB and the ledger reads one number per company from it;
 * this object is the same filing rolled up to companies, ~43 kB, published once per
 * release. `weights` is `company_id → integer basis points`, so the contract's unit
 * survives the round trip and the single conversion to fractions stays in
 * `benchmarkFromRollup`. It is derived, so the release validator recomputes it from
 * the fund document beside it and refuses a release where the two disagree.
 *
 * `as_of` is the **filing period end**, not the release id: the benchmark is compared
 * against a portfolio whose funds were filed at various dates, and its own lag is
 * part of what the caption discloses.
 */
export interface BenchmarkRollup {
  schema_version: number;
  kind: "benchmark";
  ticker: string;
  fund_id: string;
  name: string;
  as_of: string;
  filed_at: string;
  lag_days: number;
  coverage_pct: number;
  source_url: string;
  weights: Record<string, number>;
}

/** The benchmark as it appears in the ledger: its provenance, without the weights. */
export type BenchmarkFacts = Omit<BenchmarkComparison, "weights">;

/**
 * One contribution to a company line: a fund's look-through weight in it, or the
 * visitor's own direct position.
 *
 * The distinction is not cosmetic. A fund's weight is the fund's *filing* times the
 * visitor's allocation, aged by up to 150 days; a direct position is the visitor's
 * own entry, current by definition. A single "sources" list that called both a fund
 * ticker would make a stock masquerade as a fund (ADR-0014).
 */
export type LedgerSource =
  | { kind: "fund"; ref: string; weight: number }
  | { kind: "security"; ref: string; weight: number };

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
  /**
   * ISO-3166-1 alpha-2 code for the company's domicile, or `null` when this release does
   * not answer the question — no country object, or the filings disagree about it.
   *
   * Required rather than optional so every consumer of a row has to decide what it does
   * with the question; `null` is the answer "not known", and the row renders no tag. It
   * is read from the release's map, never computed, voted, or inferred here.
   */
  country: string | null;
  /** Fraction of the whole portfolio. */
  weight: number;
  /**
   * The company's weight **inside the benchmark fund** — a share of the
   * benchmark's NAV, not of the portfolio. `0` means the benchmark's traced
   * holdings do not include the company; `null` means there is no benchmark to
   * compare with, and the ledger must not print a zero in its place.
   */
  benchmark_weight: number | null;

  /** How many funds hold it — funds only, so a direct position is never counted. */
  holder_count: number;
  /** True when the visitor holds this company directly, whatever the funds do. */
  held_directly: boolean;
  /** Per-source contribution, largest first, for the ledger's second line. */
  sources: LedgerSource[];
}

/** Portfolio-level aggregates. A null metric is "not computable", never zero. */
export interface LedgerMetrics {
  /** Fraction. `Σ wᵢ²` over positive ledger weights. */
  hhi: number | null;
  effective_n: number | null;
  /** Fraction of portfolio weight in the ten largest companies. */
  top10: number | null;
  /**
   * Share of the **invested** weight whose company is known, as a percentage.
   *
   * `100 · (1 − U/T)` where `T` is invested weight (funds + direct, cash excluded)
   * and `U = Σ_k W_k · (1 − c_k)` over funds only. A direct position is fully
   * covered by construction: the visitor named the company. Cash is outside both
   * terms, so adding cash can never raise this number — that is the property that
   * stops the denominator being gamed (`lookthrough-math-and-qa` §5).
   */
  covered_weight_pct: number;
  /** Fraction of the portfolio that resolved to a company. */
  resolved_weight: number;
  /** Portfolio weight in funds whose coverage band suppresses metrics. */
  suppressed_weight: number;
  /** Funds + direct holdings: the denominator of coverage. Cash is not in it. */
  invested_weight: number;
  /** Cash entries, as a fraction of the portfolio. */
  cash_weight: number;
  /**
   * Percentage-mode only: the part of 100% that has no entry at all. Non-zero means
   * the portfolio is incomplete, and the view refuses to render numbers for it.
   */
  unallocated_weight: number;
}

/**
 * What the uncovered part of a portfolio is made of.
 *
 * The old ledger carried one number — the count of positions with no company id
 * — and the ledger printed it as "N holdings unmapped". On a five-fund global
 * portfolio that is 3,126, which reads as 3,126 failures; in fact 2,354 of those
 * positions round to 0.00% of their fund, and 74 are cash or derivatives, which
 * have no company **by definition** (`lookthrough-math-and-qa` §3). Coverage is
 * a statement about money, so the display needs weights, and it needs the cause
 * split rather than one alarming total (math §5, §7a).
 */
export interface UnmappedBreakdown {
  /** Every filed position with no company id, zero-weight rows included. */
  positions: number;
  /** Of those, the ones that carry any weight at all (`weight_bp !== 0`). */
  positions_with_weight: number;
  /** Share positions (equity, debt, fund, other) that carry weight — the real gap. */
  securities_with_weight: number;
  /** Portfolio weight those share positions represent, as a fraction. */
  securities_weight: number;
  /** Cash and derivative lines that carry weight: no company by definition. */
  cash_and_derivatives_with_weight: number;
  /** Portfolio weight those lines represent (net), as a fraction. */
  cash_and_derivatives_weight: number;
  /**
   * The share positions above, split by the country their own filing states for the
   * position (`filed_country`), as portfolio-weight fractions. The empty string is the
   * key for a position whose filing states no country.
   *
   * This is what lets the Markets bar place weight that resolved to no company: a
   * security with no company still has a market, and the filing says which. Absent on
   * every release published before 2026-11-05, and read as `{}` when absent.
   */
  securities_by_country: Record<string, number>;
}

export interface Ledger {
  rows: LedgerRow[];
  metrics: LedgerMetrics;
  /**
   * The benchmark this ledger was compared against, or `null` when the release
   * publishes none. Never a placeholder: without it the comparison column is
   * absent, not a column of zeros.
   */
  benchmark: BenchmarkFacts | null;
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
      | "identified_pct"
      | "coverage_by_cat"
      | "identified_by_cat"
    >
  >;
  /** Oldest filing period in the portfolio, for the freshness strip. */
  oldest_as_of: string | null;
  /** Largest `lag_days`, for the freshness strip. */
  max_lag_days: number | null;
  /** Positions that could not be tied to a company, by cause and by weight. */
  unmapped: UnmappedBreakdown;
  /**
   * The equal-sized-holdings pair, computed from these merged rows.
   *
   * It lives on the ledger rather than in a component because it is the same arithmetic
   * the worker already runs: the component reads a number, it does not compute one
   * (`lookthrough-math-and-qa` §2).
   */
  effective: import("./effective-holdings").EffectiveHoldings;
}
