"use client";

/**
 * Loading state for the pointer and the funds it names.
 *
 * Four states, never two: `loading`, `error`, `empty`, and `ready`. A failed load
 * keeps the documents already in memory, because replacing a ledger with an error
 * page loses the user's portfolio for a transient network blip
 * (`static-xray-frontend` §5).
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { DataError, loadFund, loadManifest, tickersFromManifest } from "./data";
import type { FundDocument, ReleaseManifest } from "./types";

export type LoadState<T> =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: T; error: null }
  | {
      status: "error";
      data: null;
      error: { message: string; detail: string; kind: string };
    };

function toError(error: unknown): { message: string; detail: string; kind: string } {
  if (error instanceof DataError) {
    return { message: error.message, detail: error.detail, kind: error.kind };
  }
  return {
    message: "Something went wrong reading the release.",
    detail: error instanceof Error ? error.message : String(error),
    kind: "unknown",
  };
}

export function useRelease(): LoadState<{
  manifest: ReleaseManifest;
  tickers: string[];
}> {
  const [state, setState] = useState<
    LoadState<{ manifest: ReleaseManifest; tickers: string[] }>
  >({
    status: "loading",
    data: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    loadManifest()
      .then((manifest) => {
        if (cancelled) return;
        setState({
          status: "ready",
          data: { manifest, tickers: tickersFromManifest(manifest) },
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ status: "error", data: null, error: toError(error) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

export interface FundsState {
  funds: FundDocument[];
  /** Tickers still loading, so the UI can name them rather than say "loading". */
  pending: string[];
  error: { message: string; detail: string } | null;
}

const RETRY_DELAY_MS = 400;

/**
 * A network failure is usually transient — a reset connection, a dropped
 * HTTP/2 stream — so it is retried once before the user is told anything.
 *
 * One cold load during the day-3 browser run failed this way and the failure was
 * remembered, which made a momentary glitch look permanent. Only `network` is
 * retried: a bad hash, a 404, or schema mismatch is a real answer and retrying it
 * would just delay the truth.
 */
async function loadWithRetry(
  release: ReleaseManifest,
  ticker: string,
): Promise<FundDocument> {
  try {
    return await loadFund(release, ticker);
  } catch (error) {
    if (error instanceof DataError && error.kind === "network") {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return loadFund(release, ticker);
    }
    throw error;
  }
}

/**
 * Load the funds for a ticker list, keeping every document already fetched.
 *
 * Documents are kept in a map keyed by ticker and the visible list is derived
 * from it at render time, so removing a fund and adding it back is instant and
 * adding a sixth does not blank the five on screen.
 *
 * Two guards, both learned from the day-3 browser run:
 * - `loadedRef` mirrors the state so the effect can test what is already present
 *   without depending on state it would then re-trigger on. Without it the effect
 *   re-ran while the first five requests were still in flight and fetched every
 *   fund twice — 312 KB instead of 156 KB, invisible except in resource timing.
 * - `inflight` stops a second request for a ticker whose first request is still
 *   open, which is the case that produced the duplicate.
 */
export function useFunds(
  manifest: ReleaseManifest | null,
  tickers: string[],
): FundsState {
  const [loaded, setLoaded] = useState<Record<string, FundDocument>>({});
  // Keyed by the ticker list: a failure belongs to the portfolio that asked for
  // it and must not survive into a different one.
  const [failure, setFailure] = useState<{
    key: string;
    message: string;
    detail: string;
  } | null>(null);
  const loadedRef = useRef<Record<string, FundDocument>>({});
  const inflight = useRef(new Set<string>());
  const key = tickers.join(",");

  useEffect(() => {
    if (!manifest) return;
    const wanted = key === "" ? [] : key.split(",");
    for (const ticker of wanted) {
      if (loadedRef.current[ticker] || inflight.current.has(ticker)) continue;
      inflight.current.add(ticker);
      loadWithRetry(manifest, ticker)
        .then((fund) => {
          inflight.current.delete(ticker);
          loadedRef.current = { ...loadedRef.current, [ticker]: fund };
          setLoaded((previous) =>
            previous[ticker] ? previous : { ...previous, [ticker]: fund },
          );
        })
        .catch((problem: unknown) => {
          inflight.current.delete(ticker);
          setFailure({ key, ...toError(problem) });
        });
    }
  }, [manifest, key]);

  const funds = useMemo(
    () =>
      (key === "" ? [] : key.split(","))
        .map((ticker) => loaded[ticker])
        .filter((fund): fund is FundDocument => Boolean(fund)),
    [key, loaded],
  );

  const pending = useMemo(
    () => (key === "" ? [] : key.split(",")).filter((ticker) => !loaded[ticker]),
    [key, loaded],
  );

  return {
    funds,
    pending,
    error:
      failure && failure.key === key
        ? { message: failure.message, detail: failure.detail }
        : null,
  };
}
