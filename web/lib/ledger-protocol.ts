/**
 * The main-thread ↔ worker contract.
 *
 * Aggregation runs off the main thread because it is the only step that touches
 * every holding of every fund, and it will grow by an order of magnitude on day
 * 4. Requests carry a `requestId` so a slow answer to an old portfolio cannot
 * overwrite a fast answer to the current one — stale results are dropped, not
 * rendered.
 */

import type { BenchmarkComparison, DirectHolding, FundDocument, Ledger } from "./types";

export interface AggregateRequest {
  type: "aggregate";
  requestId: number;
  funds: FundDocument[];
  /** Fund ticker → fraction of the whole portfolio. */
  weights: Record<string, number>;
  /** Positions held directly, already resolved and weighted. */
  direct: DirectHolding[];
  /** Cash as a fraction of the whole portfolio. */
  cash: number;
  /**
   * The fixed benchmark, already reduced to `company_id → share of its own NAV`.
   *
   * The whole fund document would be 1.5 MB of holdings to clone to the worker on
   * every weight change; the comparison needs the weights and its provenance, not
   * the filed rows ([ADR-0015](../../../docs/04-decisions/ADR-0015-vt-benchmark.md)).
   */
  benchmark: BenchmarkComparison | null;
}

export interface AggregateSuccess {
  type: "result";
  requestId: number;
  ledger: Ledger;
  durationMs: number;
}

export interface AggregateFailure {
  type: "error";
  requestId: number;
  message: string;
}

export type AggregateResponse = AggregateSuccess | AggregateFailure;
