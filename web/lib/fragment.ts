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
 */

import { FULL_ALLOCATION_BP, type Portfolio, type PortfolioEntry } from "./types";

export const FRAGMENT_VERSION = "v1";
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

/** Accepts a raw hash (`#v1.…`) or a bare fragment (`v1.…`). */
export function decodePortfolio(hash: string): DecodeResult {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw.length === 0) return { ok: false, reason: "empty" };
  if (raw.length > MAX_FRAGMENT_CHARS) return { ok: false, reason: "too-long" };

  const dot = raw.indexOf(".");
  if (dot < 0) return { ok: false, reason: "malformed" };
  const version = raw.slice(0, dot);
  if (version !== FRAGMENT_VERSION) return { ok: false, reason: "unknown-version" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(raw.slice(dot + 1)));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (!Array.isArray(parsed)) return { ok: false, reason: "malformed" };
  const seen = new Set<string>();
  const entries: PortfolioEntry[] = [];
  for (const value of parsed) {
    if (!isEntry(value)) return { ok: false, reason: "invalid-entry" };
    const [ticker, weightBp] = value;
    if (seen.has(ticker)) return { ok: false, reason: "invalid-entry" };
    seen.add(ticker);
    entries.push({ ticker, weight_bp: weightBp });
  }
  if (entries.length === 0) return { ok: false, reason: "empty" };

  const portfolio = { entries: sortEntries(entries) };
  return { ok: true, portfolio, balanced: isBalanced(portfolio.entries) };
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
