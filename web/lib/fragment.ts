/**
 * The portfolio lives in `location.hash`, and nowhere else.
 *
 * Browsers do not send the fragment in an HTTP request, which is the whole
 * privacy guarantee: the portfolio never reaches a server or its logs. The
 * format is `#v1.<base64url>`, versioned because an old link must either decode
 * exactly or be refused — never partially guessed at, since a dropped fund is a
 * wrong answer rather than a smaller one (`static-xray-frontend` §4).
 *
 * The payload is `[[ticker, weight_bp], …]`, sorted by ticker before encoding so
 * one portfolio has exactly one URL.
 *
 * Version 2 (`{"a":[…],"b":[…]}`) carries two portfolios for the comparison view.
 * It exists as a new version rather than a flag on v1 for the reason above: a v1
 * decoder must not half-read a v2 link and show one side of a comparison as if it
 * were the whole answer. A v2 link opened on `/x` shows side A, which is the
 * portfolio the ledger can honestly render.
 */

import { FULL_ALLOCATION_BP, type Portfolio, type PortfolioEntry } from "./types";

export const FRAGMENT_VERSION = "v1";
export const COMPARE_VERSION = "v2";
export const MAX_FRAGMENT_CHARS = 2000;

export type DecodeFailure =
  "empty" | "too-long" | "unknown-version" | "malformed" | "invalid-entry";

export type DecodeResult =
  | { ok: true; portfolio: Portfolio; balanced: boolean }
  | { ok: false; reason: DecodeFailure };

const TICKER_RE = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Sorted by ticker, so the same portfolio always produces the same string. */
export function sortEntries(entries: PortfolioEntry[]): PortfolioEntry[] {
  return [...entries].sort((a, b) =>
    a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0,
  );
}

export function totalWeightBp(entries: PortfolioEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.weight_bp, 0);
}

export function isBalanced(entries: PortfolioEntry[]): boolean {
  return totalWeightBp(entries) === FULL_ALLOCATION_BP;
}

export function encodePortfolio(portfolio: Portfolio): string {
  const payload = sortEntries(portfolio.entries).map((entry) => [
    entry.ticker,
    entry.weight_bp,
  ]);
  return `${FRAGMENT_VERSION}.${toBase64Url(JSON.stringify(payload))}`;
}

function isEntry(value: unknown): value is [string, number] {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [ticker, weightBp] = value;
  return (
    typeof ticker === "string" &&
    TICKER_RE.test(ticker) &&
    typeof weightBp === "number" &&
    Number.isInteger(weightBp) &&
    weightBp >= 0 &&
    weightBp <= FULL_ALLOCATION_BP
  );
}

export interface Comparison {
  a: PortfolioEntry[];
  b: PortfolioEntry[];
}

export type CompareDecodeResult =
  | {
      ok: true;
      a: PortfolioEntry[];
      b: PortfolioEntry[];
      balancedA: boolean;
      balancedB: boolean;
    }
  | { ok: false; reason: DecodeFailure };

/** Read the version and payload of a hash, without interpreting the payload. */
function split(hash: string): { version: string; payload: string } | DecodeFailure {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw.length === 0) return "empty";
  if (raw.length > MAX_FRAGMENT_CHARS) return "too-long";
  const dot = raw.indexOf(".");
  if (dot < 0) return "malformed";
  return { version: raw.slice(0, dot), payload: raw.slice(dot + 1) };
}

function parseEntries(values: unknown): PortfolioEntry[] | null {
  if (!Array.isArray(values)) return null;
  const seen = new Set<string>();
  const entries: PortfolioEntry[] = [];
  for (const value of values) {
    if (!isEntry(value)) return null;
    const [ticker, weightBp] = value;
    if (seen.has(ticker)) return null;
    seen.add(ticker);
    entries.push({ ticker, weight_bp: weightBp });
  }
  return sortEntries(entries);
}

function decodePayload(payload: string): unknown {
  try {
    return JSON.parse(fromBase64Url(payload));
  } catch {
    return undefined;
  }
}

/**
 * Accepts a raw hash (`#v1.…`, `#v2.…`) or a bare fragment, and returns both
 * sides. A v1 link is a comparison with an empty second side.
 */
export function decodeComparison(hash: string): CompareDecodeResult {
  const head = split(hash);
  if (typeof head === "string") return { ok: false, reason: head };

  if (head.version === FRAGMENT_VERSION) {
    const payload = decodePayload(head.payload);
    if (payload === undefined) return { ok: false, reason: "malformed" };
    const a = parseEntries(payload);
    if (!a) return { ok: false, reason: "invalid-entry" };
    if (a.length === 0) return { ok: false, reason: "empty" };
    return { ok: true, a, b: [], balancedA: isBalanced(a), balancedB: false };
  }

  if (head.version !== COMPARE_VERSION) return { ok: false, reason: "unknown-version" };

  const parsed = decodePayload(head.payload) as Comparison | undefined;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "malformed" };
  }
  const a = parseEntries(parsed.a ?? []);
  const b = parseEntries(parsed.b ?? []);
  if (!a || !b) return { ok: false, reason: "invalid-entry" };
  if (a.length === 0) return { ok: false, reason: "empty" };
  return { ok: true, a, b, balancedA: isBalanced(a), balancedB: isBalanced(b) };
}

/** The single-portfolio view of a hash: side A, whichever version it came from. */
export function decodePortfolio(hash: string): DecodeResult {
  const result = decodeComparison(hash);
  if (!result.ok) return { ok: false, reason: result.reason };
  return {
    ok: true,
    portfolio: { entries: result.a },
    balanced: result.balancedA,
  };
}

/** The comparison hash. A v2 link with no second side is just a portfolio. */
export function encodeComparison(a: PortfolioEntry[], b: PortfolioEntry[]): string {
  const sideA = sortEntries(a).map((entry) => [entry.ticker, entry.weight_bp]);
  const sideB = sortEntries(b).map((entry) => [entry.ticker, entry.weight_bp]);
  if (sideB.length === 0) {
    return `${FRAGMENT_VERSION}.${toBase64Url(JSON.stringify(sideA))}`;
  }
  return `${COMPARE_VERSION}.${toBase64Url(JSON.stringify({ a: sideA, b: sideB }))}`;
}

/** The URL to share: origin, path, and the fragment. No query, no shortener. */
export function shareUrl(base: string, portfolio: Portfolio): string {
  const [path] = base.split("#");
  return `${path}#${encodePortfolio(portfolio)}`;
}

/**
 * Equal weights for `count` funds, as integers, summing to exactly 10,000.
 *
 * The remainder goes to the first entries rather than being dropped, because a
 * portfolio that silently totals 9,999 bp would render a 0.01% ghost row.
 */
export function equalWeights(tickers: string[]): PortfolioEntry[] {
  if (tickers.length === 0) return [];
  const base = Math.floor(FULL_ALLOCATION_BP / tickers.length);
  const remainder = FULL_ALLOCATION_BP - base * tickers.length;
  return tickers.map((ticker, index) => ({
    ticker,
    weight_bp: base + (index < remainder ? 1 : 0),
  }));
}
