"use client";

/**
 * Runs the aggregator in a worker and exposes exactly one current ledger.
 *
 * Three behaviours matter more than the plumbing:
 * - a response whose `requestId` is not the newest is **dropped**, so editing
 *   weights quickly cannot paint weights from two keystrokes ago;
 * - if the worker cannot be created *or* fails to load, the hook falls back to
 *   running the same function on the main thread and reports `mode:
 *   'main-thread'`. Silent degradation is not allowed — the UI says so
 *   (`static-xray-frontend` §5), and the fallback means a missing worker asset is
 *   a performance regression rather than a blank page;
 * - the worker is a plain script in `public/`, built from `workers/*.ts` by
 *   `scripts/build-worker.mjs`. A `new Worker(new URL(...))` here would make
 *   Turbopack copy the `.ts` source into `_next/static/media` and the worker
 *   would never run in a static export — a defect that only shows up after
 *   `next build`, which is why the built output is inspected and not just dev.
 */

import { useEffect, useRef, useState } from "react";

import { buildLedger } from "./aggregate";
import type { AggregateRequest, AggregateResponse } from "./ledger-protocol";
import type { FundDocument, Ledger } from "./types";

export interface LedgerState {
  ledger: Ledger | null;
  error: string | null;
  /** `worker` in normal operation; `main-thread` only if the worker failed. */
  mode: "worker" | "main-thread";
  durationMs: number | null;
}

export const WORKER_URL = "/ledger.worker.js";

function createWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  try {
    return new Worker(WORKER_URL);
  } catch {
    return null;
  }
}

export function useLedger(
  funds: FundDocument[],
  weightsBp: Record<string, number>,
): LedgerState {
  const [state, setState] = useState<LedgerState>({
    ledger: null,
    error: null,
    mode: "worker",
    durationMs: null,
  });
  /** Bumped when the worker dies, to re-run the aggregation on the main thread. */
  const [generation, setGeneration] = useState(0);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const weightsKey = JSON.stringify(weightsBp);
  const fundKey = funds.map((fund) => fund.ticker).join(",");

  useEffect(() => {
    const worker = createWorker();
    workerRef.current = worker;
    if (!worker) {
      setState((previous) => ({ ...previous, mode: "main-thread" }));
      return;
    }
    worker.onmessage = (event: MessageEvent<AggregateResponse>) => {
      const response = event.data;
      if (response.requestId !== requestIdRef.current) return;
      if (response.type === "result") {
        setState({
          ledger: response.ledger,
          error: null,
          mode: "worker",
          durationMs: response.durationMs,
        });
      } else {
        setState((previous) => ({
          ...previous,
          error: response.message,
          mode: "worker",
        }));
      }
    };
    // A 404 or a parse error fires here rather than throwing at construction.
    worker.onerror = () => {
      worker.terminate();
      workerRef.current = null;
      setState((previous) => ({ ...previous, mode: "main-thread" }));
      setGeneration((value) => value + 1);
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (funds.length === 0) {
      setState((previous) => ({
        ...previous,
        ledger: null,
        error: null,
        durationMs: null,
      }));
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    const worker = workerRef.current;
    if (worker) {
      const request: AggregateRequest = {
        type: "aggregate",
        requestId,
        funds,
        weightsBp,
      };
      worker.postMessage(request);
      return;
    }

    const started = performance.now();
    try {
      const ledger = buildLedger({ funds, weightsBp });
      setState({
        ledger,
        error: null,
        mode: "main-thread",
        durationMs: performance.now() - started,
      });
    } catch (error) {
      setState((previous) => ({
        ...previous,
        error: error instanceof Error ? error.message : String(error),
        mode: "main-thread",
      }));
    }
    // `weightsKey`/`fundKey` pin the effect to the data actually used, so a new
    // object with identical contents does not re-aggregate.
  }, [fundKey, weightsKey, generation, funds, weightsBp]);

  return state;
}
