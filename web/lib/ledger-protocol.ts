/**
 * The main-thread ↔ worker contract.
 *
 * Aggregation runs off the main thread because it is the only step that touches
 * every holding of every fund, and it will grow by an order of magnitude on day
 * 4. Requests carry a `requestId` so a slow answer to an old portfolio cannot
 * overwrite a fast answer to the current one — stale results are dropped, not
 * rendered.
 */

import type { FundDocument, Ledger } from "./types";

export interface AggregateRequest {
  type: "aggregate";
  requestId: number;
  funds: FundDocument[];
  weightsBp: Record<string, number>;
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
