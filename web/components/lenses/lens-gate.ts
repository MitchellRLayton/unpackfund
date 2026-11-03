/**
 * What a lens says while it cannot say anything.
 *
 * The four lenses are pure functions of the model, and the model spends its first
 * moments unready: the fragment is read on the client, the release descriptor has
 * to arrive, the filings for the funds in the mix have to be fetched and verified,
 * and the ledger is aggregated off the main thread. A lens that painted through
 * that would print weights from a portfolio it had not finished reading, or a
 * coverage figure with no filing behind it — and a wrong number is worse than a
 * sentence saying what is missing.
 *
 * So the gate is one function, and it returns either the finished ledger or the
 * sentence. Every lens uses it, which is what stops five lenses from each having
 * their own idea of "ready" (`static-xray-frontend` §4: the UI says so, silently
 * degrading is not allowed).
 */

import { formatFundList, formatShare, formatWeightBp } from "@/lib/format";
import type { Ledger } from "@/lib/types";
import type { WorkspaceModel } from "@/lib/use-workspace";

export type LensGate =
  { kind: "blocked"; title: string; body: string } | { kind: "ready"; ledger: Ledger };

function blocked(title: string, body: string): LensGate {
  return { kind: "blocked", title, body };
}

export function lensGateState(model: WorkspaceModel): LensGate {
  if (!model.ready) {
    return blocked(
      "Reading the link",
      "The portfolio lives in the address bar. This lens waits until the link has been read, because a list of funds from half a link would be a different portfolio.",
    );
  }

  if (model.release.status === "loading") {
    return blocked(
      "Waiting for the release",
      "Nothing can be counted until the app knows which release the filings come from. This lens has no numbers to show yet.",
    );
  }

  if (model.release.status === "error") {
    return blocked(
      "The release could not be read",
      `${model.release.error.message} The lens has no numbers to show, because every number it prints is a number from that release.`,
    );
  }

  // `hasEntries` rather than `hasHoldings`: an entry of cash is a real portfolio, and
  // it gets its own sentence rather than "No portfolio yet".
  if (!model.hasEntries) {
    return blocked(
      "No portfolio yet",
      "Add a fund, a stock, or cash in the Portfolio pane. This lens is built from the holdings you enter, and it loads nothing on its own.",
    );
  }

  if (!model.complete) {
    const unallocated = model.split.unallocated;
    if (unallocated > 0) {
      return blocked(
        "The portfolio is not whole yet",
        `${formatShare(unallocated)} of it has no entry. The lens waits for a whole portfolio rather than re-scaling the part that is here: a weight that is not a share of your money would be a different answer.`,
      );
    }
    if (model.portfolio.overBp > 0) {
      return blocked(
        "The entries are over the whole",
        `They add up to ${formatWeightBp(model.portfolio.total)}. Take an amount down until the entries total 100% and the lens will compute from them.`,
      );
    }
    return blocked(
      "No amount has been entered yet",
      "The holdings are listed but every amount is zero, so there is nothing to weigh. Enter an amount against at least one holding.",
    );
  }

  // A complete portfolio with nothing in it but cash: a real mix, with nothing to
  // look through. Saying "no portfolio yet" here would be false, and computing a
  // coverage figure for it would be a number about nothing.
  if (!model.hasHoldings) {
    return blocked(
      "Everything is in cash",
      "Your mix holds cash and nothing else, so there are no companies, markets or funds to look through and the coverage figures do not apply to it. Add a fund or a stock and this lens will have something to count.",
    );
  }

  if (model.fundsError) {
    return blocked(
      "A filing could not be read",
      `${model.fundsError.message} The lens waits for every filing in the mix, because coverage, the filing dates and the overlap all read from a fund's own document.`,
    );
  }

  if (model.pendingFunds.length > 0) {
    return blocked(
      "Waiting for filings",
      `Still arriving: ${formatFundList(model.pendingFunds)}. A fund's coverage, its reporting period and its holdings all come from its own filing, so the lens shows nothing until every fund in the mix has one.`,
    );
  }

  if (model.ledgerError) {
    return blocked(
      "The numbers could not be computed",
      `${model.ledgerError} Nothing is shown rather than a partial figure.`,
    );
  }

  if (!model.ledger) {
    return blocked(
      "Working out the look-through",
      "The ledger is aggregating the funds' filings. This lens reads only the finished ledger, so it waits for it — roughly one frame on a fast machine and a few seconds on a large one.",
    );
  }

  return { kind: "ready", ledger: model.ledger };
}
