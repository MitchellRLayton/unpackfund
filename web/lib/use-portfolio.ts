/**
 * The portfolio, read from and written to the URL fragment.
 *
 * The fragment is the only state store: there is no server, no cookie, and no
 * `localStorage` copy that could disagree with a shared link. This hook is a thin
 * adapter over `fragment-store`, which owns the snapshot so React and the URL
 * cannot drift apart.
 *
 * Everything here is mode-aware. A `%` portfolio must total 100% before the ledger
 * renders numbers, so `complete` gates the view. A `$` portfolio is complete as soon
 * as one amount is non-zero, and its weights are the entries' shares of their own
 * total. Flipping the mode is an explicit, lossy conversion the builder confirms
 * first (`portfolio-weights.ts`).
 */

import { useCallback } from "react";
import { useSyncExternalStore } from "react";

import { isComplete, totalAmount } from "./fragment";
import { getServerSnapshot, getSnapshot, subscribe, write } from "./fragment-store";
import { convertMode, equalise as equaliseEntries } from "./portfolio-weights";
import {
  FULL_ALLOCATION_BP,
  type EntryKind,
  type EntryMode,
  type PortfolioEntry,
} from "./types";

export interface PortfolioState {
  entries: PortfolioEntry[];
  mode: EntryMode;
  /** `false` until the fragment has been read; render a shell until then. */
  ready: boolean;
  /** Decode problem, or `null` when the fragment decoded (or was absent). */
  problem: string | null;
  /** The entries' total in their own unit: basis points, or cents. */
  total: number;
  /** Whether the entries account for the whole portfolio (see `fragment.ts`). */
  complete: boolean;
  /** Percentage mode only: what is left of 100%, in basis points. */
  unallocatedBp: number;
  add: (kind: EntryKind, key: string) => void;
  remove: (kind: EntryKind, key: string) => void;
  setAmount: (kind: EntryKind, key: string, amount: number) => void;
  equalise: () => void;
  clear: () => void;
  /** Switch `%` ↔ `$`, re-expressing every amount so the split is unchanged. */
  setMode: (mode: EntryMode) => void;
  /**
   * Put a whole portfolio back, amounts included. The one caller is the builder's
   * Undo after "Remove all": `add` would re-equalise the weights, and an undo that
   * returns a different portfolio is not an undo.
   */
  replace: (entries: PortfolioEntry[]) => void;
}

/** `f`/`s`/`c` plus a key: the identity of an entry within a list. */
function isSame(entry: PortfolioEntry, kind: EntryKind, key: string): boolean {
  return entry.kind === kind && entry.key === key;
}

/**
 * The largest amount an entry may carry in the current mode.
 *
 * Dollars are cents, and $1bn is far past any real portfolio; percentages cannot
 * exceed the whole. The fragment decoder in `fragment.ts` enforces the same
 * ceilings, so a hand-edited link and the builder agree on what is out of range.
 */
function ceiling(mode: EntryMode): number {
  return mode === "bp" ? FULL_ALLOCATION_BP : 100_000_000_00;
}

export function usePortfolio(): PortfolioState {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const entries = snapshot.portfolio.entries;
  const mode = snapshot.portfolio.mode;

  const add = useCallback(
    (kind: EntryKind, key: string) => {
      if (entries.some((entry) => isSame(entry, kind, key))) return;
      const next: PortfolioEntry[] = [...entries, { kind, key, amount: 0 }];
      // Equal-weight is the default only when the portfolio was empty or already a
      // clean split; re-splitting a portfolio the visitor weighted by hand would
      // silently discard their input. Cash and stocks start at zero because the
      // visitor has to say how much — guessing a dollar amount is guessing money.
      const wasClean = mode === "bp" && totalAmount(entries) === FULL_ALLOCATION_BP;
      write({
        mode,
        entries: entries.length === 0 || wasClean ? equaliseEntries(next) : next,
      });
    },
    [entries, mode],
  );

  const remove = useCallback(
    (kind: EntryKind, key: string) => {
      write({ mode, entries: entries.filter((entry) => !isSame(entry, kind, key)) });
    },
    [entries, mode],
  );

  const setAmount = useCallback(
    (kind: EntryKind, key: string, amount: number) => {
      const max = ceiling(mode);
      const whole = Math.max(0, Math.min(max, Math.round(amount)));
      write({
        mode,
        entries: entries.map((entry) =>
          isSame(entry, kind, key) ? { ...entry, amount: whole } : entry,
        ),
      });
    },
    [entries, mode],
  );

  const equalise = useCallback(() => {
    // Dollar mode has no allocation to divide: the amounts are the visitor's money.
    if (mode !== "bp") return;
    write({ mode, entries: equaliseEntries(entries) });
  }, [entries, mode]);

  const clear = useCallback(() => {
    write({ mode, entries: [] });
  }, [mode]);

  const setMode = useCallback(
    (nextMode: EntryMode) => {
      if (nextMode === mode) return;
      write({ mode: nextMode, entries: convertMode(mode, nextMode, entries) });
    },
    [entries, mode],
  );

  const replace = useCallback(
    (next: PortfolioEntry[]) => {
      write({ mode, entries: next });
    },
    [mode],
  );

  const total = totalAmount(entries);

  return {
    entries,
    mode,
    ready: snapshot.ready,
    problem: snapshot.problem,
    total,
    complete: isComplete(mode, entries),
    unallocatedBp: mode === "bp" ? Math.max(0, FULL_ALLOCATION_BP - total) : 0,
    add,
    remove,
    setAmount,
    equalise,
    clear,
    setMode,
    replace,
  };
}
