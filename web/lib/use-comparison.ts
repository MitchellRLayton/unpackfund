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
import { FULL_ALLOCATION_BP } from "./types";
import type { PortfolioEntry } from "./types";

/**
 * Two portfolios share one fragment, and the fragment has a 2,000-character budget
 * (`fragment.ts`). Forty entries a side is what fits with the version prefix, so the
 * cap is set there: refusing an add is better than writing a link that will not open.
 */
const MAX_ENTRIES = 40;

export type Side = "a" | "b";

export interface Comparison {
  a: PortfolioEntry[];
  b: PortfolioEntry[];
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

function balance(entries: PortfolioEntry[]): number {
  return entries.reduce((total, entry) => total + entry.weight_bp, 0);
}

export function useComparison(): Comparison {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const update = useCallback((a: PortfolioEntry[], b: PortfolioEntry[]) => {
    writeComparison(a, b);
  }, []);

  const add = useCallback(
    (side: Side, ticker: string) => {
      const upper = ticker.trim().toUpperCase();
      if (!upper) return;
      const { a, b } = snapshot;
      const target = side === "a" ? a : b;
      if (target.length >= MAX_ENTRIES) return;
      if (target.some((entry) => entry.ticker === upper)) return;
      const entry = { ticker: upper, weight_bp: 0 };
      const next = [...target, entry];
      // A portfolio that is empty except for this fund is a single-fund portfolio:
      // give it the whole allocation rather than leaving it at zero, which would
      // read as "unallocated" for no reason.
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

  return {
    a: snapshot.a,
    b: snapshot.b,
    ready: snapshot.ready,
    problem: snapshot.problem,
    totalBp: { a: balance(snapshot.a), b: balance(snapshot.b) },
    balanced: {
      a: balance(snapshot.a) === FULL_ALLOCATION_BP,
      b: balance(snapshot.b) === FULL_ALLOCATION_BP,
    },
    add,
    remove,
    setWeightBp,
    equalise,
    clear,
    swap,
  };
}
