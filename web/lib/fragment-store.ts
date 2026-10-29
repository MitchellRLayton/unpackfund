"use client";

/**
 * The URL fragment as an external store.
 *
 * `useSyncExternalStore` is the right tool because the fragment genuinely lives
 * outside React: the back button, a pasted link, and our own writes all change it
 * without a render. It also solves hydration honestly — the server snapshot is
 * "nothing read yet", so the prerendered HTML never claims a portfolio is empty
 * when the visitor arrived through a shared link.
 *
 * Snapshot identity is cached, because React re-reads it on every render and a
 * fresh object each time would loop.
 */

import { decodePortfolio, encodePortfolio, sortEntries } from "./fragment";
import type { PortfolioEntry } from "./types";

export interface FragmentSnapshot {
  entries: PortfolioEntry[];
  problem: string | null;
  /** `false` until the fragment has actually been read, on the client only. */
  ready: boolean;
}

const UNREAD: FragmentSnapshot = { entries: [], problem: null, ready: false };

const PROBLEMS: Record<string, string> = {
  "unknown-version":
    "That link was made by a different version of UnpackFund, so it was not opened.",
  malformed: "That link is damaged, so no portfolio was loaded.",
  "invalid-entry":
    "That link contains a holding this app cannot read, so nothing was loaded.",
  "too-long": "That link is longer than any portfolio should be, so it was not opened.",
};

const EVENT = "unpackfund:fragment";

let cached: FragmentSnapshot | null = null;

function read(): FragmentSnapshot {
  if (typeof window === "undefined") return UNREAD;
  const result = decodePortfolio(window.location.hash);
  if (result.ok) return { entries: result.portfolio.entries, problem: null, ready: true };
  if (result.reason === "empty") return { entries: [], problem: null, ready: true };
  return {
    entries: [],
    problem: PROBLEMS[result.reason] ?? "That link could not be opened.",
    ready: true,
  };
}

export function getSnapshot(): FragmentSnapshot {
  cached ??= read();
  return cached;
}

export function getServerSnapshot(): FragmentSnapshot {
  return UNREAD;
}

export function subscribe(listener: () => void): () => void {
  const refresh = () => {
    cached = null;
    listener();
  };
  window.addEventListener("hashchange", refresh);
  window.addEventListener("popstate", refresh);
  window.addEventListener(EVENT, refresh);
  return () => {
    window.removeEventListener("hashchange", refresh);
    window.removeEventListener("popstate", refresh);
    window.removeEventListener(EVENT, refresh);
  };
}

/**
 * Replace the fragment without adding a history entry.
 *
 * A sequence of weight edits would otherwise fill the Back button with
 * intermediate portfolios, and Back should return to wherever the visitor came
 * from. Passing `replace: false` keeps a user bisecting portfolios in control.
 */
export function write(
  entries: PortfolioEntry[],
  options: { replace?: boolean } = {},
): void {
  const sorted = sortEntries(entries);
  const hash = sorted.length === 0 ? "" : `#${encodePortfolio({ entries: sorted })}`;
  const url = `${window.location.pathname}${window.location.search}${hash}`;
  if (options.replace === false) {
    window.history.pushState(null, "", url);
  } else {
    window.history.replaceState(null, "", url);
  }
  cached = { entries: sorted, problem: null, ready: true };
  window.dispatchEvent(new Event(EVENT));
}
