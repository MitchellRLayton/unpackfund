"use client";

/**
 * The empty portfolio's first card: what the page wants, and the three ways in.
 *
 * The empty state is the homepage's first impression, so it does the two things a
 * first impression has to do — it says what the page wants, and it promises the page can
 * answer. The three ways in are the three things a visitor might have: a ticker in
 * their head, a list in a spreadsheet, or nothing but curiosity.
 *
 * This file also owns the worked example (`WorkedExample`), but the workspace renders it
 * separately: the operator asked for the empty card, then the lens tabs, then the
 * example, then the actions, so the example cannot live inside this card's markup.
 *
 * `EXAMPLE_LABEL` is shown with the card and with the example every time, and
 * `isExamplePortfolio` is what makes the label follow the example once it is opened: the
 * example is never presented as a suggestion, and this is the screen where that matters
 * most.
 */

import { useMemo } from "react";

import { buildLedger } from "@/lib/aggregate";
import { write } from "@/lib/fragment-store";
import { useFunds } from "@/lib/use-release";
import type { WorkspaceModel } from "@/lib/use-workspace";

import { Summary } from "./Summary";
import { buildAnswer } from "./answer";
import { EXAMPLE_ENTRIES, EXAMPLE_LABEL, EXAMPLE_TICKERS } from "./example";
import { focusAddInput, openPasteBox } from "./HoldingsPane";
import styles from "./Workspace.module.css";

/** The example's holdings as portfolio weights: 14.29% becomes `0.1429`. */
const EXAMPLE_WEIGHTS: Record<string, number> = Object.fromEntries(
  EXAMPLE_ENTRIES.map((entry) => [entry.key, entry.amount / 10_000]),
);

/**
 * Load the example into the URL.
 *
 * One write with the mode set to percent: the example's amounts are basis points, and
 * writing them into dollar mode would read 1,429 as $14.29. `write` is the store's own
 * entry point, so the address bar, the snapshot and every lens agree immediately.
 */
function loadExample(): void {
  write({ mode: "bp", entries: EXAMPLE_ENTRIES.map((entry) => ({ ...entry })) });
}

/**
 * The worked example: real numbers, fetched and aggregated, rendered after the lens tabs.
 *
 * It is a component of its own rather than part of `EmptyState` because the workspace
 * renders it between the lens tabs and the actions, and one component that renders two
 * places in a page is two components wearing one name. The example's funds are fetched,
 * aggregated and turned into the same answer strip and the same coverage sentence the
 * visitor's own portfolio will get, so what is on screen is a demonstration of the
 * mechanism rather than a mock-up of it.
 *
 * The row chips name the funds and deliberately print no weights: the percentages are
 * what the visitor gets *after* opening the example, from the holdings pane's own total,
 * and printing them here would present a finished allocation before anything was chosen.
 */
export function WorkedExample({ model }: { model: WorkspaceModel }) {
  const releaseData = model.release.status === "ready" ? model.release.data : null;
  // The same loader the real portfolio uses, on the example's seven tickers. It is the
  // only fetch the example makes, and only while the portfolio is empty.
  const { funds, pending } = useFunds(releaseData, EXAMPLE_TICKERS);

  // The example's ledger is built once and used twice: the answer strip and the
  // effective-holdings sentence both read it, and a second build would be a second answer
  // to the same question.
  const ledger = useMemo(() => {
    if (funds.length < EXAMPLE_TICKERS.length) return null;
    return buildLedger({
      funds,
      weights: EXAMPLE_WEIGHTS,
      countries: model.countries,
    });
  }, [funds, model.countries]);

  const answer = useMemo(() => {
    if (ledger === null) {
      return buildAnswer({
        kind: "loading",
        pending: pending.length > 0 ? pending : EXAMPLE_TICKERS,
        fundCount: EXAMPLE_TICKERS.length,
      });
    }
    return buildAnswer({ kind: "ready", ledger, funds });
  }, [ledger, funds, pending]);

  return (
    <section className="card stack stack--tight" aria-labelledby="example-heading">
      <div className="row row--between">
        <h2 id="example-heading" className="subtitle">
          Worked example
        </h2>
        <button type="button" className="btn btn--sm" onClick={loadExample}>
          Open the example
        </button>
      </div>
      <p className={styles.exampleLabel}>{EXAMPLE_LABEL}</p>
      <ul className={styles.exampleRows}>
        {EXAMPLE_ENTRIES.map((entry) => (
          <li key={entry.key}>
            <span className="chip chip--mono">{entry.key}</span>
          </li>
        ))}
      </ul>
      <Summary answer={answer} effective={ledger?.effective} />
    </section>
  );
}

/**
 * `onReveal` shows the holdings pane and then runs the focus it is given.
 *
 * The pane is collapsed on a phone, so a card that focuses the add field has to open the
 * pane first; the shell owns that state, so the card asks it rather than reaching for it.
 *
 * The card is all this renders. `WorkedExample` is its sibling in the page, placed after
 * the lens tabs by `Workspace`.
 */
export function EmptyState({
  model,
  onReveal,
}: {
  model: WorkspaceModel;
  onReveal: (then?: () => void) => void;
}) {
  return (
    <section className="stack stack--loose" aria-labelledby="empty-heading">
      <div className="empty">
        <h2 id="empty-heading" className="empty__title">
          Nothing in this portfolio yet
        </h2>
        <p className="muted">
          Add a fund, a stock, or cash, and the companies behind them appear here — with
          the coverage and the filing dates that qualify every number.
        </p>
        <div className="ways-in">
          <div className="way">
            <p className="way__title">Type it</p>
            <p className="small muted">
              One line at a time: a ticker, a fund name, an issuer, or a stock symbol.
            </p>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => onReveal(focusAddInput)}
            >
              Add a holding
            </button>
          </div>
          <div className="way">
            <p className="way__title">Paste it</p>
            <p className="small muted">
              A whole list at once — <span className="mono">VTI 40%</span>,{" "}
              <span className="mono">VXUS $12,000</span>.
            </p>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => onReveal(openPasteBox)}
            >
              Paste a list
            </button>
          </div>
          <div className="way">
            <p className="way__title">Try an example</p>
            <p className="small muted">{EXAMPLE_LABEL}</p>
            <button type="button" className="btn btn--sm" onClick={loadExample}>
              Open the example
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
