/**
 * Loading a release: pointer → `releases/{as_of}/…`, in that order, always.
 *
 * The app never constructs a release path from a date it decided itself; it
 * reads `manifest.as_of` and follows it (`data-contract-and-release` §4). That is
 * what makes a pointer move atomic: the release is fully published and verified
 * before anything reads it, and a rollback is a copy rather than an edit.
 *
 * Every fund is hash-checked against the manifest before it is used. The cost is
 * a few milliseconds for a 128 KB document and the benefit is that a truncated
 * or half-written object fails loudly here instead of becoming a plausible wrong
 * number on screen.
 */

import {
  SCHEMA_VERSION,
  type FundDocument,
  type ManifestFile,
  type ReleaseManifest,
} from "./types";

/**
 * Where the pointer lives.
 *
 * Day 3 reads the **non-live** rehearsal prefix, so nothing here can promote a
 * release; promoting means pointing at `latest/manifest.json`, which is a
 * separate, deliberate production step.
 */
export const DATA_BASE = (
  process.env.NEXT_PUBLIC_DATA_BASE ?? "https://data.unpackfund.com"
).replace(/\/$/, "");
export const POINTER_PATH =
  process.env.NEXT_PUBLIC_POINTER_PATH ?? "staging/latest/manifest.json";

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

function assertManifest(value: unknown): ReleaseManifest {
  const manifest = value as ReleaseManifest;
  if (
    !manifest ||
    typeof manifest !== "object" ||
    manifest.schema_version !== SCHEMA_VERSION ||
    typeof manifest.as_of !== "string" ||
    !Array.isArray(manifest.files)
  ) {
    throw new DataError(
      "schema",
      "The pointer does not describe a release this app understands.",
      `Expected schema_version ${SCHEMA_VERSION} with an as_of and files[].`,
    );
  }
  return manifest;
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

export async function loadManifest(
  fetchImpl: FetchImpl = fetch,
): Promise<ReleaseManifest> {
  return assertManifest(await getJson(POINTER_URL, fetchImpl));
}

/** `funds/VOO.json` → `VOO`. The manifest is the catalog; nothing is assumed. */
export function tickersFromManifest(manifest: ReleaseManifest): string[] {
  return manifest.files
    .map((file) => /^funds\/([A-Z0-9.\-]+)\.json$/.exec(file.path)?.[1])
    .filter((ticker): ticker is string => Boolean(ticker))
    .sort();
}

export function fundFile(manifest: ReleaseManifest, ticker: string): ManifestFile {
  const file = manifest.files.find(
    (candidate) => candidate.path === `funds/${ticker}.json`,
  );
  if (!file) {
    throw new DataError(
      "missing-fund",
      `${ticker} is not in this release.`,
      `Release ${manifest.as_of} lists ${tickersFromManifest(manifest).join(", ")}.`,
    );
  }
  return file;
}

export function releaseUrl(manifest: ReleaseManifest, path: string): string {
  return `${DATA_BASE}/releases/${encodeURIComponent(manifest.as_of)}/${path}`;
}

export async function loadFund(
  manifest: ReleaseManifest,
  ticker: string,
  fetchImpl: FetchImpl = fetch,
): Promise<FundDocument> {
  const file = fundFile(manifest, ticker);
  const url = releaseUrl(manifest, file.path);

  let response: Response;
  try {
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
      `${ticker} could not be loaded.`,
      `${url} answered ${response.status}.`,
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = await sha256Hex(bytes);
  if (digest !== file.sha256) {
    throw new DataError(
      "hash",
      `${ticker} did not match its manifest hash, so it was not used.`,
      `expected ${file.sha256.slice(0, 12)}…, received ${digest.slice(0, 12)}… (${bytes.byteLength} B, manifest says ${file.bytes} B).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new DataError("schema", `${ticker} is not valid JSON.`, describe(error));
  }
  return assertFund(parsed, ticker);
}

/** Load several funds, keeping the portfolio's order. */
export async function loadFunds(
  manifest: ReleaseManifest,
  tickers: string[],
  fetchImpl: FetchImpl = fetch,
): Promise<FundDocument[]> {
  return Promise.all(tickers.map((ticker) => loadFund(manifest, ticker, fetchImpl)));
}
