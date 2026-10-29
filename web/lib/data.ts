/**
 * Loading a release: pointer → `releases/{as_of}/…`, in that order, always.
 *
 * The app never constructs a release path from a date it decided itself; it
 * reads the pointer's `as_of` and follows it (`data-contract-and-release` §4). That
 * is what makes a pointer move atomic: the release is fully published and verified
 * before anything reads it, and a rollback is a copy rather than an edit.
 *
 * What the pointer publishes changed on day 5. It used to be the inventory — one
 * entry per fund with its hash — which meant every visitor downloaded 8,533 entries
 * (1.29 MB raw, 0.42 MB gzipped) before verifying a single fund. It is now a
 * descriptor of about 1.5 KB, and the objects it names are fetched as needed:
 *
 *     tickers.json          the builder's ticker list          (~25 KB gzipped)
 *     index/{L}.json        bytes + sha256 for funds starting L (per portfolio)
 *     catalogue.json        names, for search                  (lazy, /c/ only)
 *     companies/{id}.json   who holds one company              (lazy, per company)
 *
 * Every fund is still hash-checked before it is used, against the shard that names
 * it. The cost is one small request; the benefit is that a truncated or
 * half-written object fails loudly here instead of becoming a plausible wrong
 * number on screen.
 */

import {
  RELEASE_SCHEMA_VERSION,
  SCHEMA_VERSION,
  type Catalogue,
  type CatalogueRow,
  type FundAliases,
  type CompanyIndex,
  type CompanyShard,
  type FundDocument,
  type FundIndexShard,
  type ReleaseDescriptor,
  type TickerList,
} from "./types";

/**
 * Where the pointer lives.
 *
 * `latest/release.json` since 2026-10-30: the pointer's name carries its schema, so
 * day 4's `latest/manifest.json` (a 1.29 MB inventory) and this descriptor are never
 * confused for one another. Production is promoted deliberately by the pipeline
 * (`release upload --allow-live`), so the app reads the live pointer and a preview
 * build overrides it:
 *
 *     NEXT_PUBLIC_POINTER_PATH=staging/latest/release.json pnpm build
 *
 * A default of `staging/` in a production build is worse than wrong data: it makes
 * the live site render a rehearsal pointer that a later staging upload can move.
 */
export const DATA_BASE = (
  process.env.NEXT_PUBLIC_DATA_BASE ?? "https://data.unpackfund.com"
).replace(/\/$/, "");
export const POINTER_PATH = process.env.NEXT_PUBLIC_POINTER_PATH ?? "latest/release.json";

export const POINTER_URL = `${DATA_BASE}/${POINTER_PATH}`;

export type DataErrorKind = "network" | "status" | "schema" | "hash" | "missing-fund";

export class DataError extends Error {
  readonly kind: DataErrorKind;
  readonly detail: string;

  constructor(kind: DataErrorKind, message: string, detail = "") {
    super(message);
    this.name = "DataError";
    this.kind = kind;
    this.detail = detail;
  }
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getJson(url: string, fetchImpl: FetchImpl): Promise<unknown> {
  let response: Response;
  try {
    // `no-cache` asks intermediaries for a fresh copy: a cached 404 from before
    // an upload would otherwise be indistinguishable from a missing release.
    response = await fetchImpl(url, { cache: "no-cache" });
  } catch (error) {
    throw new DataError(
      "network",
      "Could not reach the data host.",
      `${url}: ${describe(error)} — this is either offline or a blocked request, not a missing fund.`,
    );
  }
  if (!response.ok) {
    throw new DataError(
      "status",
      response.status === 404
        ? "That release is not published yet."
        : "The data host returned an error.",
      `${url} answered ${response.status}.`,
    );
  }
  try {
    return await response.json();
  } catch (error) {
    throw new DataError(
      "schema",
      "The data host returned something that is not JSON.",
      `${url}: ${describe(error)}`,
    );
  }
}

function assertRelease(value: unknown): ReleaseDescriptor {
  const release = value as ReleaseDescriptor;
  const objects = release?.objects;
  if (
    !release ||
    typeof release !== "object" ||
    release.schema_version !== RELEASE_SCHEMA_VERSION ||
    release.kind !== "release" ||
    typeof release.as_of !== "string" ||
    !objects ||
    typeof objects.tickers?.path !== "string" ||
    typeof objects.catalogue?.path !== "string" ||
    typeof objects.fund_index?.prefix !== "string" ||
    !Array.isArray(objects.fund_index.shards)
  ) {
    throw new DataError(
      "schema",
      "The pointer does not describe a release this app understands.",
      `Expected a schema_version ${RELEASE_SCHEMA_VERSION} release descriptor with as_of and objects{}.`,
    );
  }
  return release;
}

function assertFund(value: unknown, ticker: string): FundDocument {
  const fund = value as FundDocument;
  if (
    !fund ||
    typeof fund !== "object" ||
    fund.schema_version !== SCHEMA_VERSION ||
    typeof fund.ticker !== "string" ||
    !Array.isArray(fund.holdings)
  ) {
    throw new DataError(
      "schema",
      `The ${ticker} artifact is not the shape this app expects.`,
      `Expected schema_version ${SCHEMA_VERSION} with holdings[].`,
    );
  }
  return fund;
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function loadRelease(
  fetchImpl: FetchImpl = fetch,
): Promise<ReleaseDescriptor> {
  return assertRelease(await getJson(POINTER_URL, fetchImpl));
}

/** `releases/{as_of}/…`, the only way a release path is ever built. */
export function releaseUrl(release: ReleaseDescriptor, path: string): string {
  return `${DATA_BASE}/releases/${encodeURIComponent(release.as_of)}/${path}`;
}

/** The shard a ticker is verified against: its first character, or `_`. */
export function shardFor(ticker: string): string {
  const first = ticker.slice(0, 1).toUpperCase();
  return first >= "A" && first <= "Z" ? first : "_";
}

async function fetchBytes(
  url: string,
  what: string,
  fetchImpl: FetchImpl,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImpl(url, { cache: "no-cache" });
  } catch (error) {
    throw new DataError(
      "network",
      "Could not reach the data host.",
      `${url}: ${describe(error)} — this is either offline or a blocked request, not a missing ${what}.`,
    );
  }
  if (!response.ok) {
    throw new DataError(
      "status",
      response.status === 404
        ? `That ${what} is not published yet.`
        : "The data host returned an error.",
      `${url} answered ${response.status}.`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

function parseJson(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new DataError("schema", `The ${what} is not valid JSON.`, describe(error));
  }
}

/** Fetch one object and check it against the hash the descriptor publishes. */
async function loadDescribed<T>(
  release: ReleaseDescriptor,
  descriptor: { path: string; bytes: number; sha256: string },
  what: string,
  fetchImpl: FetchImpl,
): Promise<T> {
  const url = releaseUrl(release, descriptor.path);
  const bytes = await fetchBytes(url, what, fetchImpl);
  const digest = await sha256Hex(bytes);
  if (digest !== descriptor.sha256) {
    throw new DataError(
      "hash",
      `The ${what} did not match the hash the release publishes, so it was not used.`,
      `expected ${descriptor.sha256.slice(0, 12)}…, received ${digest.slice(0, 12)}… (${bytes.byteLength} B, release says ${descriptor.bytes} B).`,
    );
  }
  return parseJson(bytes, what) as T;
}

export async function loadTickers(
  release: ReleaseDescriptor,
  fetchImpl: FetchImpl = fetch,
): Promise<string[]> {
  const document = await loadDescribed<TickerList>(
    release,
    release.objects.tickers,
    "ticker list",
    fetchImpl,
  );
  if (!document || document.as_of !== release.as_of || !Array.isArray(document.tickers)) {
    throw new DataError(
      "schema",
      "The ticker list does not belong to this release.",
      `as_of ${document?.as_of ?? "missing"}, release ${release.as_of}.`,
    );
  }
  return document.tickers;
}

/**
 * Shards are cached per release: a five-fund portfolio touches one or two, and
 * adding a sixth fund with a familiar first letter must not re-fetch.
 */
const shardCache = new Map<string, Promise<FundIndexShard>>();

async function loadShard(
  release: ReleaseDescriptor,
  letter: string,
  fetchImpl: FetchImpl,
): Promise<FundIndexShard> {
  const key = `${release.as_of}:${letter}`;
  const cached = shardCache.get(key);
  if (cached) return cached;

  const path = `${release.objects.fund_index.prefix}${letter}.json`;
  const pending = (async () => {
    const bytes = await fetchBytes(releaseUrl(release, path), "fund index", fetchImpl);
    const document = parseJson(bytes, "fund index") as FundIndexShard;
    if (
      !document ||
      document.as_of !== release.as_of ||
      typeof document.funds !== "object"
    ) {
      throw new DataError(
        "schema",
        "The fund index does not belong to this release.",
        `${path}: as_of ${document?.as_of ?? "missing"}, release ${release.as_of}.`,
      );
    }
    return document;
  })();
  shardCache.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    // A failed shard must not be remembered: the next attempt gets a fresh fetch.
    shardCache.delete(key);
    throw error;
  }
}

/** Drop cached shards; tests use it, and a release change invalidates them anyway. */
export function clearShardCache(): void {
  shardCache.clear();
}

export async function loadFund(
  release: ReleaseDescriptor,
  ticker: string,
  fetchImpl: FetchImpl = fetch,
): Promise<FundDocument> {
  const shard = await loadShard(release, shardFor(ticker), fetchImpl);
  const entry = shard.funds[ticker];
  if (!entry) {
    throw new DataError(
      "missing-fund",
      `${ticker} is not in this release.`,
      `Release ${release.as_of} publishes ${release.fund_count} funds; ${ticker} is not one of them.`,
    );
  }

  const url = releaseUrl(release, `funds/${ticker}.json`);
  const bytes = await fetchBytes(url, ticker, fetchImpl);
  const digest = await sha256Hex(bytes);
  if (digest !== entry.sha256) {
    throw new DataError(
      "hash",
      `${ticker} did not match its published hash, so it was not used.`,
      `expected ${entry.sha256.slice(0, 12)}…, received ${digest.slice(0, 12)}… (${bytes.byteLength} B, release says ${entry.bytes} B).`,
    );
  }
  return assertFund(parseJson(bytes, `${ticker} artifact`), ticker);
}

/** Load several funds, keeping the portfolio's order. */
export async function loadFunds(
  release: ReleaseDescriptor,
  tickers: string[],
  fetchImpl: FetchImpl = fetch,
): Promise<FundDocument[]> {
  return Promise.all(tickers.map((ticker) => loadFund(release, ticker, fetchImpl)));
}

/** `catalogue.json`: a label for every fund in the release. Lazy — search only. */
export async function loadCatalogue(
  release: ReleaseDescriptor,
  fetchImpl: FetchImpl = fetch,
): Promise<Catalogue> {
  const document = await loadDescribed<Catalogue>(
    release,
    release.objects.catalogue,
    "catalogue",
    fetchImpl,
  );
  if (
    !document ||
    document.as_of !== release.as_of ||
    typeof document.funds !== "object"
  ) {
    throw new DataError(
      "schema",
      "The catalogue does not belong to this release.",
      `as_of ${document?.as_of ?? "missing"}, release ${release.as_of}.`,
    );
  }
  return document;
}

/** `companies/index.json`: every company in the release, for search. */
export async function loadCompanyIndex(
  release: ReleaseDescriptor,
  fetchImpl: FetchImpl = fetch,
): Promise<CompanyIndex> {
  const document = await loadDescribed<CompanyIndex>(
    release,
    release.objects.companies.index,
    "company index",
    fetchImpl,
  );
  if (
    !document ||
    document.as_of !== release.as_of ||
    !Array.isArray(document.companies)
  ) {
    throw new DataError(
      "schema",
      "The company index does not belong to this release.",
      `as_of ${document?.as_of ?? "missing"}, release ${release.as_of}.`,
    );
  }
  return document;
}

/**
 * `companies/{company_id}.json`: which funds hold one company, and how much.
 *
 * No hash to check here — the descriptor does not enumerate 5,179 shards — so the
 * `as_of` and the identity fields are checked instead, and a mismatch is refused
 * rather than rendered: a shard from another release would be a plausible wrong
 * answer, which is worse than an error.
 */
export async function loadCompany(
  release: ReleaseDescriptor,
  companyId: string,
  fetchImpl: FetchImpl = fetch,
): Promise<CompanyShard> {
  const path = `${release.objects.companies.prefix}${encodeURIComponent(companyId)}.json`;
  const bytes = await fetchBytes(releaseUrl(release, path), "company", fetchImpl);
  const document = parseJson(bytes, "company") as CompanyShard;
  if (
    !document ||
    document.as_of !== release.as_of ||
    document.company_id !== companyId ||
    !Array.isArray(document.funds)
  ) {
    throw new DataError(
      "schema",
      "That company record does not belong to this release.",
      `${path}: as_of ${document?.as_of ?? "missing"}, release ${release.as_of}.`,
    );
  }
  return document;
}

/**
 * `aliases.json`: share-class ticker → published ticker. Lazy, and only on a miss.
 *
 * The happy path must not pay for this object: a visitor who types a published
 * ticker never fetches it, and one who types the class they actually hold pays
 * roughly 60 KB to be told which page their fund is on.
 */
export async function loadAliases(
  release: ReleaseDescriptor,
  fetchImpl: FetchImpl = fetch,
): Promise<FundAliases> {
  if (!release.objects.aliases) {
    throw new DataError(
      "schema",
      "This release does not publish share-class tickers.",
      "A release built before the alias map existed cannot resolve a class ticker.",
    );
  }
  const document = await loadDescribed<FundAliases>(
    release,
    release.objects.aliases.object,
    "aliases",
    fetchImpl,
  );
  if (
    !document ||
    document.as_of !== release.as_of ||
    typeof document.targets !== "object"
  ) {
    throw new DataError(
      "schema",
      "The alias map does not belong to this release.",
      `as_of ${document?.as_of ?? "missing"}, release ${release.as_of}.`,
    );
  }
  return document;
}

const aliasCache = new Map<string, Promise<FundAliases | null>>();

/**
 * The published ticker a share-class ticker belongs to, or `null`.
 *
 * Cached per release and never rejected: a missing or unreadable alias map means
 * "cannot resolve", which the caller reports as an unknown ticker — the same
 * answer it gave before this object existed. In-flight promises are shared so two
 * submits in quick succession cost one fetch.
 */
export async function resolveAlias(
  release: ReleaseDescriptor,
  ticker: string,
  fetchImpl: FetchImpl = fetch,
): Promise<string | null> {
  const key = `${release.as_of}:${release.objects.aliases?.object?.path ?? ""}`;
  let pending = aliasCache.get(key);
  if (!pending) {
    pending = loadAliases(release, fetchImpl).catch(() => null);
    aliasCache.set(key, pending);
  }
  const aliases = await pending;
  return aliases?.targets[ticker] ?? null;
}

/** The catalogue row for a ticker, or `null` when the release does not list it. */
export function catalogueRow(
  catalogue: Catalogue | null,
  ticker: string,
): CatalogueRow | null {
  return catalogue?.funds[ticker] ?? null;
}
