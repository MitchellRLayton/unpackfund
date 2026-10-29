/**
 * The look-through aggregator, off the main thread.
 *
 * It owns no state between messages: every request carries the whole portfolio,
 * so a worker restart is invisible and two portfolios cannot contaminate each
 * other. `postMessage` is the only output.
 *
 * The scope is typed locally rather than by adding the `webworker` lib to
 * `tsconfig`, because that lib collides with `dom` in a Next project and the
 * collision is noisier than these two methods.
 */

import { buildLedger } from "../lib/aggregate";
import type { AggregateRequest, AggregateResponse } from "../lib/ledger-protocol";

interface WorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<AggregateRequest>) => void,
  ): void;
  postMessage(message: AggregateResponse): void;
}

const scope = self as unknown as WorkerScope;

scope.addEventListener("message", (event) => {
  const request = event.data;
  if (!request || request.type !== "aggregate") return;

  const started = performance.now();
  try {
    const ledger = buildLedger({ funds: request.funds, weightsBp: request.weightsBp });
    scope.postMessage({
      type: "result",
      requestId: request.requestId,
      ledger,
      durationMs: performance.now() - started,
    });
  } catch (error) {
    scope.postMessage({
      type: "error",
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
