"use client";

/**
 * Which fund the comparison column is against.
 *
 * The choice is a **display preference**, not portfolio state: it says which published
 * fund supplies the benchmark weights and carries no amount, ticker or total of the
 * visitor's own. So it lives in the query string — `?bench=voo` — and never in the
 * fragment, which is the portfolio's alone (invariant I3). It is also not a second
 * portfolio: switching the benchmark does not change the portfolio, the ledger's totals,
 * or any other column; it changes the pair of comparison columns and the sentence that
 * introduces them.
 *
 * VT is the default, so a visitor who never picks keeps the URL they arrived with:
 * `?bench=vt` is never written, and the parameter is removed when the reader goes back to
 * VT. The choice is written with `history.replaceState`, not `pushState`, so picking a
 * benchmark does not fill the back button with states of a view.
 *
 * **Nothing is stored.** `lib/legal.ts` tells the reader the site writes nothing to
 * localStorage or sessionStorage, and that sentence is a legal statement rather than a
 * preference: a display toggle is not worth making it false. The query string survives a
 * reload, is shareable, and puts the choice in the URL where a reader can see it.
 *
 * One module-level store, read through `useSyncExternalStore`, so the workspace (which
 * loads the weights) and the lens (which draws the picker) cannot disagree about which
 * fund is selected. The server snapshot is the default, because a static export is
 * prerendered without a query string; the URL is read in an effect, after hydration.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { DEFAULT_BENCHMARK, parseBenchmark, type BenchmarkTicker } from "./benchmark";

/** The query-string key: `?bench=voo`. VT is the default and is never written. */
export const BENCHMARK_PARAM = "bench";

/** The benchmark a query string names, or `null` when it names none. */
export function benchmarkFromSearch(search: string): BenchmarkTicker | null {
  return parseBenchmark(new URLSearchParams(search).get(BENCHMARK_PARAM));
}

/**
 * The query string for a benchmark, keeping every other parameter.
 *
 * The default writes nothing, so a reader who never picks keeps the URL they arrived
 * with. The fragment is not this function's business: `URL` keeps it, and it is the
 * portfolio's.
 */
export function benchmarkSearch(search: string, ticker: BenchmarkTicker): string {
  const params = new URLSearchParams(search);
  if (ticker === DEFAULT_BENCHMARK) params.delete(BENCHMARK_PARAM);
  else params.set(BENCHMARK_PARAM, ticker.toLowerCase());
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

let current: BenchmarkTicker = DEFAULT_BENCHMARK;
let hydrated = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): BenchmarkTicker {
  return current;
}

function serverSnapshot(): BenchmarkTicker {
  return DEFAULT_BENCHMARK;
}

/** Read the URL once, after hydration: a static export is prerendered without one. */
function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const named = benchmarkFromSearch(window.location.search);
  if (named !== null && named !== current) {
    current = named;
    emit();
  }
}

/**
 * Choose a benchmark: the URL, then the store.
 *
 * `replaceState` rather than `pushState` — a toggle is a view, and the back button should
 * leave the page rather than walk back through comparisons. The fragment is untouched.
 */
export function chooseBenchmark(ticker: BenchmarkTicker): void {
  hydrated = true;
  const url = new URL(window.location.href);
  url.search = benchmarkSearch(url.search, ticker);
  window.history.replaceState(window.history.state, "", url);
  if (ticker === current) return;
  current = ticker;
  emit();
}

/** The benchmark on screen, and the way to change it. */
export function useBenchmarkPreference(): {
  benchmark: BenchmarkTicker;
  setBenchmark: (ticker: BenchmarkTicker) => void;
} {
  const benchmark = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  useEffect(() => {
    hydrate();
  }, []);
  const setBenchmark = useCallback((next: BenchmarkTicker) => chooseBenchmark(next), []);
  return { benchmark, setBenchmark };
}

/** Test seam: forget the URL's answer and go back to the default. */
export function resetBenchmarkPreference(): void {
  hydrated = false;
  if (current === DEFAULT_BENCHMARK) return;
  current = DEFAULT_BENCHMARK;
  emit();
}
