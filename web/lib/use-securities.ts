"use client";

/**
 * Resolve the stock symbols in a portfolio to companies, from the release.
 *
 * A stock the visitor typed is only ever an identity from the release's own
 * `securities/` object (ADR-0014): the symbol is looked up, its `company_id` is the
 * one the funds already use, and the ledger then adds the two contributions to one
 * company line. Nothing is derived from the ticker itself — a symbol is a label, and
 * `BRK.B`/`BRK-B` prove it.
 *
 * Three outcomes are kept distinct, because they are different sentences:
 * - resolved: the symbol is published and `ok`;
 * - refused: the symbol is published with a status that says it is not a common
 *   stock (a fund, a preferred, a warrant, a unit, a right, an index-tracking ETN);
 * - missing: the symbol is not in this release at all.
 *
 * "Pending" is *derived* from the request key rather than stored, so the hook has no
 * state to synchronise when the portfolio changes: a result belongs to the request
 * that asked for it, and anything else is by definition still loading. That keeps the
 * first render after a keystroke honest — it says "loading", not "missing".
 */

import { useEffect, useState } from "react";

import { loadSecurities } from "./data";
import type { ReleaseDescriptor, SecuritiesRow } from "./types";

export interface SecuritiesState {
  /** Symbol → its published row, for every symbol the release has. */
  rows: Map<string, SecuritiesRow>;
  /** Symbols this release does not carry. */
  missing: string[];
  /** True while any needed shard is still being read. */
  pending: boolean;
  error: string | null;
}

const EMPTY_ROWS: Map<string, SecuritiesRow> = new Map();

export function useSecurities(
  release: ReleaseDescriptor | null,
  symbols: string[],
): SecuritiesState {
  // Sorted, so the effect is keyed by the *set* of symbols and not by the order the
  // visitor happened to add them in.
  const key = symbols.slice().sort().join(",");
  const request = release ? `${release.as_of}\u0000${key}` : "";
  const [result, setResult] = useState<{
    request: string;
    state: Omit<SecuritiesState, "pending">;
  } | null>(null);

  useEffect(() => {
    if (!release || key === "") return;
    let cancelled = false;
    loadSecurities(release, symbols)
      .then((rows) => {
        if (cancelled) return;
        setResult({
          request,
          state: {
            rows,
            missing: symbols.filter((symbol) => !rows.has(symbol)),
            error: null,
          },
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // A failure to read the object is not "the symbol is not a stock": the page
        // says the release could not be read instead of blaming the input.
        setResult({
          request,
          state: {
            rows: EMPTY_ROWS,
            missing: symbols,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      });
    return () => {
      cancelled = true;
    };
    // `request` is the whole identity of the read; `symbols` is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  if (result && result.request === request) {
    return { ...result.state, pending: false };
  }
  return {
    rows: EMPTY_ROWS,
    missing: [],
    pending: release !== null && key !== "",
    error: null,
  };
}
