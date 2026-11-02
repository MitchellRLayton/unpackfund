/**
 * What each published symbol status means to the person who typed it.
 *
 * The statuses are decided at build time (`pipeline/securities.py`) and this module
 * turns them into one sentence each. Keeping the sentences here rather than inline
 * in the builder is what stops the refusal copy and the acceptance rule from
 * drifting apart — the tests pin both against the same table.
 *
 * None of these is advice. "SPY is a fund, so add it as a fund" is a statement about
 * which list the object is on, not a recommendation about the holding.
 */

import type { SecurityStatus } from "./types";

/** The only status the builder may add as a directly-held stock. */
export function accepts(status: SecurityStatus): boolean {
  return status === "ok";
}

/**
 * The sentence a refusal shows. `null` means the status is accepted.
 *
 * Each one names what the object *is* and what to do instead, because "not
 * supported" is the kind of message that makes a visitor retype the same thing.
 */
export function refusal(status: SecurityStatus): string | null {
  switch (status) {
    case "ok":
      return null;
    case "fund":
      return "That ticker is a fund in this release, so add it as a fund — its own holdings are already in the look-through.";
    case "pfd":
      return "That is a preferred share, which is a different claim on the company from the common stock the funds report, so it cannot be counted as one company position.";
    case "wnt":
      return "That is a warrant, not a share of the company.";
    case "unit":
      return "That is a unit — a bundle of shares and warrants sold together — not a share of the company.";
    case "rgt":
      return "That is a right to buy shares, not a share of the company.";
    case "twin":
      return "That symbol names two companies or two share classes, so it cannot be mapped to one company.";
  }
}

/** A short chip label, for a row that shows the reason in a word. */
export function statusLabel(status: SecurityStatus): string {
  switch (status) {
    case "ok":
      return "common stock";
    case "fund":
      return "fund";
    case "pfd":
      return "preferred";
    case "wnt":
      return "warrant";
    case "unit":
      return "unit";
    case "rgt":
      return "right";
    case "twin":
      return "two companies";
  }
}

/**
 * Normalise what the visitor typed into the symbol the release publishes.
 *
 * Share classes are written with a dot on yfinance, a dash in the SEC's file, and
 * both in the wild: `BRK.B` and `BRK-B` are the same class. Uppercasing and
 * rewriting the dot is a *lookup* convenience, not identity — the identity still
 * comes from the release row this key finds.
 */
export function normaliseSymbol(input: string): string {
  return input.trim().toUpperCase().replace(/\./g, "-").replace(/\s+/g, "");
}

/** A symbol the fragment format can carry: `TICKER_RE` in `fragment.ts`. */
export function isCarriable(symbol: string): boolean {
  return /^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(symbol);
}
