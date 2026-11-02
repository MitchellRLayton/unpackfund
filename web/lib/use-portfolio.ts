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
import {
  convertMode,
  equalise as equaliseEntries,
  isEqualSplit,
} from "./portfolio-weights";
import { moveItem } from "./reorder";
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
  /** Percentage mode only: what is left of 100%, in basis points. Zero when over. */
  unallocatedBp: number;
  /** Percentage mode only: how far past 100% the entries are, in basis points. */
  overBp: number;
  /**
   * Append one entry, and say which of the three things happened to the amounts that
   * were already there: `split` (the app spread every row evenly, because the list was
   * still its own even split), `kept` (nothing moved; the new row arrived at 0), or
   * `noop` (that holding is already in the portfolio).
   */
  add: (kind: EntryKind, key: string) => AddOutcome;
  remove: (kind: EntryKind, key: string) => void;
  /**
   * Move one entry to a 0-based position in the list.
   *
   * The order is the visitor's, not the app's: it is what the builder shows and what
   * the link reproduces (`fragment.ts`). `toIndex` is clamped, and moving an entry to
   * where it already is writes nothing, so a drag that ends where it started does not
   * touch the URL.
   */
  move: (kind: EntryKind, key: string, toIndex: number) => void;
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
 * What `add` did to the amounts that were already in the portfolio.
 *
 * Three states rather than a boolean: "the rows were re-split" and "the rows were left
 * alone" are both successful adds, and a caller that confuses them either announces a
 * re-split that did not happen or stays silent about a 0.00% row that needs a number.
 */
export type AddOutcome = "split" | "kept" | "noop";

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
    (kind: EntryKind, key: string): AddOutcome => {
      if (entries.some((entry) => isSame(entry, kind, key))) return "noop";
      const next: PortfolioEntry[] = [...entries, { kind, key, amount: 0 }];
      // The even split is the default only for a portfolio the app itself spread —
      // empty, or still exactly the split `equalise` would produce. A set the visitor
      // weighted by hand keeps every amount it has, because moving a number they typed
      // is silent data loss: "I added a fund and my whole portfolio reset to equal
      // weights" (operator, 2026-11-02). Whole is not the test — `60/40` is whole and
      // is still the visitor's, which is why the check is `isEqualSplit`, not a total.
      // Cash and stocks additionally start at zero: guessing a dollar amount is
      // guessing money.
      const followSplit =
        entries.length === 0 || (mode === "bp" && isEqualSplit(entries));
      write({ mode, entries: followSplit ? equaliseEntries(next) : next });
      return followSplit ? "split" : "kept";
    },
    [entries, mode],
  );

  const remove = useCallback(
    (kind: EntryKind, key: string) => {
      write({ mode, entries: entries.filter((entry) => !isSame(entry, kind, key)) });
    },
    [entries, mode],
  );

  const move = useCallback((kind: EntryKind, key: string, toIndex: number) => {
    // Read the *current* snapshot rather than the closure's `entries`: a pointer drag
    // can fire several moves before React re-renders, and a stale list would reorder
    // the wrong row. `write` clears the snapshot cache, so each call sees its own
    // predecessor.
    const current = getSnapshot().portfolio;
    const from = current.entries.findIndex((entry) => isSame(entry, kind, key));
    if (from < 0) return;
    const to = Math.max(0, Math.min(current.entries.length - 1, toIndex));
    if (to === from) return;
    write({ mode: current.mode, entries: moveItem(current.entries, from, to) });
  }, []);

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
    // Both are zero unless the total is off the whole, and only one of them can be
    // positive: the pair is how the builder says "short" or "over" without sign maths
    // in the view.
    overBp: mode === "bp" ? Math.max(0, total - FULL_ALLOCATION_BP) : 0,
    add,
    remove,
    move,
    setAmount,
    equalise,
    clear,
    setMode,
    replace,
  };
}
