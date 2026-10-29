"use client";

/**
 * The portfolio, read from and written to the URL fragment.
 *
 * The fragment is the only state store: there is no server, no cookie, and no
 * `localStorage` copy that could disagree with a shared link. This hook is a thin
 * adapter over `fragment-store`, which owns the snapshot so React and the URL
 * cannot drift apart.
 */

import { useCallback, useSyncExternalStore } from "react";

import { equalWeights, totalWeightBp } from "./fragment";
import { getServerSnapshot, getSnapshot, subscribe, write } from "./fragment-store";
import { FULL_ALLOCATION_BP, type PortfolioEntry } from "./types";

export interface PortfolioState {
  entries: PortfolioEntry[];
  /** `false` until the fragment has been read; render a shell until then. */
  ready: boolean;
  /** Decode problem, or `null` when the fragment decoded (or was absent). */
  problem: string | null;
  totalBp: number;
  balanced: boolean;
  add: (ticker: string) => void;
  remove: (ticker: string) => void;
  setWeightBp: (ticker: string, weightBp: number) => void;
  equalise: () => void;
  clear: () => void;
}

export function usePortfolio(): PortfolioState {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const entries = snapshot.a;

  const add = useCallback(
    (ticker: string) => {
      if (entries.some((entry) => entry.ticker === ticker)) return;
      const wasBalanced = totalWeightBp(entries) === FULL_ALLOCATION_BP;
      const tickers = [...entries.map((entry) => entry.ticker), ticker];
      // Equal-weight is the default only when the portfolio was balanced or
      // empty; re-splitting a portfolio the user has weighted by hand would
      // silently discard their input.
      const next =
        entries.length === 0 || wasBalanced
          ? equalWeights(tickers)
          : [...entries, { ticker, weight_bp: 0 }];
      write(next);
    },
    [entries],
  );

  const remove = useCallback(
    (ticker: string) => {
      write(entries.filter((entry) => entry.ticker !== ticker));
    },
    [entries],
  );

  const setWeightBp = useCallback(
    (ticker: string, weightBp: number) => {
      const clamped = Math.max(0, Math.min(FULL_ALLOCATION_BP, Math.round(weightBp)));
      write(
        entries.map((entry) =>
          entry.ticker === ticker ? { ...entry, weight_bp: clamped } : entry,
        ),
      );
    },
    [entries],
  );

  const equalise = useCallback(() => {
    write(equalWeights(entries.map((entry) => entry.ticker)));
  }, [entries]);

  const clear = useCallback(() => {
    write([]);
  }, []);

  const totalBp = totalWeightBp(entries);

  return {
    entries,
    ready: snapshot.ready,
    problem: snapshot.problem,
    totalBp,
    balanced: totalBp === FULL_ALLOCATION_BP,
    add,
    remove,
    setWeightBp,
    equalise,
    clear,
  };
}
