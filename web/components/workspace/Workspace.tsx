"use client";

/**
 * The workspace: one page that answers "what do I own?" and lets you change the question.
 *
 * Both `/` and `/x/` mount this component. There is no second implementation and no
 * "simple version" and "full version": a visitor who lands on either URL gets the same
 * portfolio, the same ledger and the same five lenses, because the page's identity is
 * the fragment, not the route. The route only decides the title a link preview shows.
 *
 * The arrangement, top to bottom:
 *
 * - **The answer first.** Three to five sentences, built in code from the finished ledger,
 *   then the coverage note under them.
 * - **The holdings, in a left column.** They are the input to everything else, so they
 *   stay visible while a lens scrolls — and on a phone they collapse to a chip bar above
 *   the results, because a list of rows above the answer would push the answer off the
 *   screen.
 * - **The lenses, below the answer.** The five tables, on the URL's own state.
 * - **The actions, last.** A share link, a comparison, a file, a page.
 *
 * Honesty rules the shell enforces, whatever a lens does:
 *
 * - an incomplete portfolio (percentages that do not add to 100%) is said out loud before
 *   any number is shown, because a ledger computed from a partial split is a ledger of a
 *   different portfolio;
 * - a fund whose filing has not arrived is named, not silently missing;
 * - a failed load is a sentence, never an empty table.
 */

import { useCallback, useMemo, useState } from "react";

import { useWorkspace } from "@/lib/use-workspace";

import { ActionsRow } from "./ActionsRow";
import { AnswerStrip } from "./AnswerStrip";
import { buildAnswer, type Answer, type AnswerInput } from "./answer";
import { EmptyState } from "./EmptyState";
import { EXAMPLE_LABEL, isExamplePortfolio } from "./example";
import { HoldingsChips, HoldingsPane } from "./HoldingsPane";
import { LensTabs } from "./LensTabs";
import { PrintSummary } from "./PrintSummary";
import styles from "./Workspace.module.css";

export function Workspace() {
  const model = useWorkspace();
  const [paneOpen, setPaneOpen] = useState(false);

  // One definition, on the model: cash is an entry even though it is not a holding.
  const hasEntries = model.hasEntries;

  /**
   * Show the pane, then run what the visitor actually asked for.
   *
   * On a phone the pane is collapsed, so a card that says "Paste it" has to open the pane
   * *before* it can focus the textarea inside it. The callback runs in the next frame,
   * after React has put the pane back in flow — focusing an element inside a `display:
   * none` wrapper does nothing, silently.
   */
  const revealPane = useCallback((then?: () => void) => {
    setPaneOpen(true);
    if (then) window.requestAnimationFrame(then);
  }, []);

  const answer = useMemo<Answer>(() => {
    if (!hasEntries) return buildAnswer({ kind: "empty" });
    if (!model.complete) {
      const input: AnswerInput = {
        kind: "incomplete",
        mode: model.portfolio.mode,
        totalBp: model.portfolio.total,
        unallocatedBp: model.portfolio.unallocatedBp,
        overBp: model.portfolio.overBp,
      };
      return buildAnswer(input);
    }
    if (!model.ledger) {
      return buildAnswer({
        kind: "loading",
        pending: model.pendingFunds,
        fundCount: model.funds.length,
      });
    }
    return buildAnswer({ kind: "ready", ledger: model.ledger, funds: model.funds });
  }, [
    hasEntries,
    model.complete,
    model.portfolio.mode,
    model.portfolio.total,
    model.portfolio.unallocatedBp,
    model.portfolio.overBp,
    model.ledger,
    model.pendingFunds,
    model.funds,
  ]);

  const isExample =
    hasEntries && isExamplePortfolio(model.portfolio.mode, model.portfolio.entries);

  const head = (
    <header className={styles.head}>
      <p className="eyebrow">X-Ray</p>
      <h1 className="title">See the companies behind your funds</h1>
      {/* The explanation is for someone who has not entered anything yet. Once there
       * are holdings, the answer strip is the explanation, and three lines of preamble
       * would push the numbers below the fold on a phone. */}
      {hasEntries ? null : (
        <p className="subtitle">
          Add the funds you own and UnpackFund adds their SEC filings up: the companies
          you hold, the markets they are in, and how much of each fund could be traced to
          a company at all.
        </p>
      )}
    </header>
  );

  if (!model.ready) {
    return (
      <div className="shell page workspace">
        {head}
        <p className="small muted" role="status">
          Reading the link…
        </p>
      </div>
    );
  }

  return (
    <div className="shell page workspace">
      {head}

      {model.problem ? (
        <div className="notice notice--alert" role="alert">
          <div>
            <p>
              <strong>That link could not be read.</strong>
            </p>
            <p className="small muted">{model.problem}</p>
          </div>
        </div>
      ) : null}

      {model.release.status === "error" ? (
        <div className="notice notice--alert" role="alert">
          <div>
            <p>
              <strong>The release could not be read.</strong>
            </p>
            <p className="small muted">{model.release.error.message}</p>
          </div>
        </div>
      ) : null}

      <div className="workspace__grid">
        <div className="workspace__holdings no-print">
          {hasEntries ? (
            <HoldingsChips
              model={model}
              open={paneOpen}
              onToggle={() => setPaneOpen((open) => !open)}
            />
          ) : null}
          <div
            id="holdings-pane-region"
            className={`${styles.paneWrap}${
              paneOpen || !hasEntries ? ` ${styles.paneOpen}` : ""
            }`}
          >
            <HoldingsPane model={model} />
          </div>
        </div>

        <div className="stack stack--loose">
          <AnswerStrip answer={answer}>
            {isExample ? <p className={styles.exampleLabel}>{EXAMPLE_LABEL}</p> : null}
          </AnswerStrip>

          {model.fundsError ? (
            <div className="notice notice--alert" role="alert">
              <div>
                <p>
                  <strong>Some filings could not be read.</strong>
                </p>
                <p className="small muted">
                  {model.fundsError.message} {model.fundsError.detail}
                </p>
              </div>
            </div>
          ) : null}

          {model.ledgerError ? (
            <div className="notice notice--alert" role="alert">
              <div>
                <p>
                  <strong>The look-through could not be finished.</strong>
                </p>
                <p className="small muted">{model.ledgerError}</p>
              </div>
            </div>
          ) : null}

          {!hasEntries ? <EmptyState model={model} onReveal={revealPane} /> : null}

          <LensTabs model={model} />
          <ActionsRow model={model} />
        </div>
      </div>

      <PrintSummary model={model} answer={answer} />
    </div>
  );
}
