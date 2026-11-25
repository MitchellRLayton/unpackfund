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
 * An empty portfolio reads in the operator's order: the "no holdings yet" card, then the
 * lens tabs, then the actions. The example's ticker chips live inside that card, so there
 * is one empty state rather than a card plus a second block below it.
 *
 * Honesty rules the shell enforces, whatever a lens does:
 *
 * - an incomplete portfolio (percentages that do not add to 100%) is said out loud before
 *   any number is shown, because a ledger computed from a partial split is a ledger of a
 *   different portfolio;
 * - a fund whose filing has not arrived is named, not silently missing;
 * - a failed load is a sentence, never an empty table.
 */

import { useCallback, useMemo, useRef, useState } from "react";

import { portfolioSignature } from "@/lib/portfolio-weights";
import { useWorkspace } from "@/lib/use-workspace";
import type { PortfolioEntry } from "@/lib/types";

import { useProvider } from "@/components/lenses/provider-preference";

import { ActionsRow } from "./ActionsRow";
import { buildAnswer, type Answer, type AnswerInput } from "./answer";
import { buildMetrics } from "./metrics";
import { EmptyState } from "./EmptyState";
import { HoldingsChips, HoldingsCompact, HoldingsPane } from "./HoldingsPane";
import { LensTabs } from "./LensTabs";
import { PrintSummary } from "./PrintSummary";
import { ResultsPlaceholder } from "./ResultsPlaceholder";
import { scrollBelowTopBar } from "./scroll";
import styles from "./Workspace.module.css";

export function Workspace() {
  const model = useWorkspace();
  // The answer strip names the convention its market sentence uses, so it has to be the
  // one the Markets lens is showing: one choice, read from the URL, in both places.
  const { provider } = useProvider();
  const [paneOpen, setPaneOpen] = useState(false);
  // One definition, on the model: cash is an entry even though it is not a holding.
  const hasEntries = model.hasEntries;

  /**
   * A link that arrives with a whole portfolio is a visitor who wants the results, not
   * the form, so the pane starts collapsed. Decided once, in the render that first sees
   * the fragment (React's own pattern for state derived from a prop; an effect would
   * paint the open form for a frame first): a portfolio built by hand on this page stays
   * open until its owner says they are done.
   */
  const signature = portfolioSignature(model.portfolio.mode, model.portfolio.entries);
  const [landed, setLanded] = useState<{ signature: string | null } | null>(null);
  if (landed === null && model.ready) {
    setLanded({ signature: hasEntries && model.complete ? signature : null });
  }
  const landedWhole = landed !== null && landed.signature !== null;
  /**
   * Results are shown only for a portfolio the visitor has submitted: this is its
   * signature, `undefined` until they submit, and then the link's own portfolio stands in
   * (a shared link is a portfolio somebody already put forward). Pressing "Show results",
   * or a clean paste that totals 100%, records the signature of what was on the page; any
   * later edit moves the signature, so the results step back until it is submitted again.
   */
  const [submitted, setSubmitted] = useState<string | null | undefined>(undefined);
  const submittedSignature =
    submitted !== undefined ? submitted : (landed?.signature ?? null);
  const resultsShown = hasEntries && model.complete && submittedSignature === signature;
  /** A note the paste box leaves for the collapsed list: the pane that held it has gone. */
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  /**
   * The visitor's own choice, `null` until they make one. The pane is collapsed when they
   * pressed "Show results" (or Edit, to undo it), and otherwise as the link landed. In
   * memory only — the brief's rule is that nothing is remembered between visits except
   * the address bar, and a collapsed pane is a view preference, not portfolio state.
   */
  const [paneChoice, setPaneCollapsed] = useState<boolean | null>(null);
  const paneCollapsed = paneChoice ?? landedWhole ?? false;
  const resultsRef = useRef<HTMLDivElement>(null);

  /**
   * "Show results": put the form away and bring the answer into view. The phone's drawer
   * closes too, and focus moves to the results so a keyboard or screen-reader visitor
   * lands where the page changed rather than on a button that has just left. The lens tabs
   * land just under the top bar at full size; they dock into it only once the visitor
   * scrolls past them.
   */
  const showResults = useCallback(
    (pasted?: { entries: PortfolioEntry[]; note: string }) => {
      // A paste submits the list it just wrote, which the render in hand has not seen yet.
      setSubmitted(
        pasted ? portfolioSignature(model.portfolio.mode, pasted.entries) : signature,
      );
      setPasteNote(pasted?.note ?? null);
      setPaneCollapsed(true);
      setPaneOpen(false);
      // Focus without the browser's own scroll, which would put the results at y = 0 —
      // behind the sticky top bar, so the lens tabs docked before the visitor scrolled.
      // The explicit scroll lands the tabs just under the bar, at full size.
      window.requestAnimationFrame(() => {
        const results = resultsRef.current;
        if (!results) return;
        results.focus({ preventScroll: true });
        scrollBelowTopBar(results);
      });
    },
    [model.portfolio.mode, signature],
  );

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
    return buildAnswer({
      kind: "ready",
      ledger: model.ledger,
      funds: model.funds,
      contested: model.contested,
      provider,
    });
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
    model.contested,
    provider,
  ]);

  const metrics = useMemo(() => buildMetrics(model, provider), [model, provider]);

  /**
   * The hero is for the empty state only.
   *
   * Once there is a portfolio the top bar already says "Portfolio", the metric strip
   * says what is in it, and the hero was 200 px of preamble between the reader and the
   * numbers. The `<h1>` stays, visually hidden, so the document still has one and the
   * heading order is unchanged.
   */
  const head = hasEntries ? (
    <h1 className="visually-hidden">See the companies behind your funds</h1>
  ) : (
    <header className={styles.head}>
      <h1 className="title">See the companies behind your funds</h1>
      <p className="subtitle">Add the funds you own to see every company inside them.</p>
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
              onToggle={() => {
                setPaneCollapsed(false);
                setPaneOpen((open) => !open);
              }}
            />
          ) : null}
          <div
            id="holdings-pane-region"
            className={`${styles.paneWrap}${
              paneOpen || !hasEntries ? ` ${styles.paneOpen}` : ""
            }`}
          >
            {paneCollapsed && hasEntries ? (
              <HoldingsCompact
                model={model}
                note={pasteNote}
                onExpand={() => {
                  setPasteNote(null);
                  setPaneCollapsed(false);
                }}
              />
            ) : (
              <HoldingsPane model={model} onShowResults={showResults} />
            )}
          </div>
        </div>

        <div
          ref={resultsRef}
          id="results-region"
          tabIndex={-1}
          className={`stack stack--loose ${styles.results}`}
        >
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

          {!hasEntries ? <EmptyState onReveal={revealPane} /> : null}

          {hasEntries && !resultsShown ? (
            <ResultsPlaceholder
              portfolio={model.portfolio}
              onShowResults={() => showResults()}
            />
          ) : (
            <>
              <LensTabs model={model} metrics={metrics} disabled={!hasEntries} />

              <ActionsRow model={model} />
            </>
          )}
        </div>
      </div>

      {resultsShown ? <PrintSummary model={model} answer={answer} /> : null}
    </div>
  );
}
