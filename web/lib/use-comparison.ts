"use client";

/**
 * Two portfolios, one URL fragment.
 *
 * The state is the fragment and nothing else — no server, no cookie, no storage —
 * so a comparison is shareable by copying the address bar, which is the property
 * the frontend skill requires of any portfolio state. Side A is the v1 fragment the
 * ledger already reads, so `/compare` with an empty B is a working link to `/x`'s
 * content and vice versa.
 *
 * Every mutator takes the side it acts on. There is no "active side" state: a
 * pointer that moves is the kind of hidden mode that makes a comparison view
 * confusing, and two explicit columns are cheaper to use than one that switches.
 */

import { useCallback } from "react";
import { useSyncExternalStore } from "react";

import {
  getServerSnapshot,
  getSnapshot,
  subscribe,
  writeComparison,
} from "./fragment-store";
import { MAX_HOLDINGS, tallyOf } from "./holdings";
import { FULL_ALLOCATION_BP } from "./types";
import type { FundWeight } from "./types";

// The cap is `holdings.MAX_HOLDINGS`, not a number of its own: two portfolios share one
// fragment, and the fragment has a 2,000-character budget (`fragment.ts`). Forty entries
// a side is what fits with the version prefix, so refusing an add is better than writing
// a link that will not open. It is imported rather than restated so the builder and the
// comparison cannot drift apart about how many rows a link may hold.

export type Side = "a" | "b";

export interface Comparison {
  a: FundWeight[];
  b: FundWeight[];
  ready: boolean;
  problem: string | null;
  totalBp: Record<Side, number>;
  balanced: Record<Side, boolean>;
  add: (side: Side, ticker: string) => void;
  remove: (side: Side, ticker: string) => void;
  setWeightBp: (side: Side, ticker: string, weightBp: number) => void;
  equalise: (side: Side) => void;
  clear: (side: Side) => void;
  swap: () => void;
}

export function useComparison(): Comparison {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const update = useCallback((a: FundWeight[], b: FundWeight[]) => {
    writeComparison(a, b);
  }, []);

  const add = useCallback(
    (side: Side, ticker: string) => {
      const upper = ticker.trim().toUpperCase();
      if (!upper) return;
      const { a, b } = snapshot;
      const target = side === "a" ? a : b;
      if (target.length >= MAX_HOLDINGS) return;
      if (target.some((entry) => entry.ticker === upper)) return;
      const entry = { ticker: upper, weight_bp: 0 };
      const next = [...target, entry];
      // A side that is empty except for this fund is a single-fund portfolio: give it
      // the whole allocation rather than leaving it at zero, which would read as
      // "unallocated" for no reason. This is the builder's own preferred default (first
      // holding 100%, second halves it, third thirds it), kept here so a one-fund side is
      // a comparison and not an unfinished list.
      //
      // It cannot fire for an add that is not the first: `next.length === 1` is false the
      // moment the side has any row, so the new entry arrives at 0 and every amount
      // already on screen is left exactly as it was. That is the rule the builder had to
      // fix on 2026-11-02 after the operator reported adding a fund reset a hand-weighted
      // portfolio to equal weights — here the old bug was structurally impossible, and it
      // must stay that way: a comparison's two sides are typed by hand, so an add that
      // re-weighted them would silently rewrite the numbers the visitor was comparing.
      // (`use-portfolio.add` needs `isEqualSplit` because it *does* re-split the app's own
      // even split; this store never re-splits anything after the first row.)
      const weighted =
        next.length === 1 ? [{ ...entry, weight_bp: FULL_ALLOCATION_BP }] : next;
      update(side === "a" ? weighted : a, side === "b" ? weighted : b);
    },
    [snapshot, update],
  );

  const remove = useCallback(
    (side: Side, ticker: string) => {
      const { a, b } = snapshot;
      const target = (side === "a" ? a : b).filter((entry) => entry.ticker !== ticker);
      update(side === "a" ? target : a, side === "b" ? target : b);
    },
    [snapshot, update],
  );

  const setWeightBp = useCallback(
    (side: Side, ticker: string, weightBp: number) => {
      const { a, b } = snapshot;
      const target = (side === "a" ? a : b).map((entry) =>
        entry.ticker === ticker
          ? { ...entry, weight_bp: Math.max(0, Math.min(FULL_ALLOCATION_BP, weightBp)) }
          : entry,
      );
      update(side === "a" ? target : a, side === "b" ? target : b);
    },
    [snapshot, update],
  );

  const equalise = useCallback(
    (side: Side) => {
      const { a, b } = snapshot;
      const target = side === "a" ? a : b;
      if (target.length === 0) return;
      const each = Math.floor(FULL_ALLOCATION_BP / target.length);
      const remainder = FULL_ALLOCATION_BP - each * target.length;
      const weighted = target.map((entry, index) => ({
        ...entry,
        weight_bp: each + (index === 0 ? remainder : 0),
      }));
      update(side === "a" ? weighted : a, side === "b" ? weighted : b);
    },
    [snapshot, update],
  );

  const clear = useCallback(
    (side: Side) => {
      const { a, b } = snapshot;
      update(side === "a" ? [] : a, side === "b" ? [] : b);
    },
    [snapshot, update],
  );

  const swap = useCallback(() => {
    update(snapshot.b, snapshot.a);
  }, [snapshot, update]);

  // The complete-vs-short rule is `holdings.tallyOf`, the same call that prints the
  // sentence on both pages, rather than a second sum compared to `FULL_ALLOCATION_BP`.
  // One function decides both facts, so a side cannot be "fully allocated" on screen and
  // incomplete to the gate that opens the overlap.
  const tallyA = tallyOf(
    "bp",
    snapshot.a.map((entry) => entry.weight_bp),
  );
  const tallyB = tallyOf(
    "bp",
    snapshot.b.map((entry) => entry.weight_bp),
  );

  return {
    a: snapshot.a,
    b: snapshot.b,
    ready: snapshot.ready,
    problem: snapshot.problem,
    totalBp: { a: tallyA.total, b: tallyB.total },
    balanced: { a: tallyA.complete, b: tallyB.complete },
    add,
    remove,
    setWeightBp,
    equalise,
    clear,
    swap,
  };
}
