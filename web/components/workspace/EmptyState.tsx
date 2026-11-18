"use client";

/**
 * The empty portfolio's first card: one heading, one line, two ways in.
 *
 * The empty state is the homepage's first impression, so it does the two things a first
 * impression has to do — it says what the page wants, and it promises the page can
 * answer. There are two ways in, and they are the two a visitor actually has: an example
 * to open, or a list in a spreadsheet to paste. Typing a ticker needs no card, because
 * the add field is in the pane beside this one.
 *
 * The example's ticker chips live here rather than in a second block below the card: the
 * card says "start from an example", so the funds that example holds belong beside the
 * button that loads them. They name the funds and deliberately print no weights — the
 * percentages arrive with the holdings pane after the example is opened, and printing
 * them here would present a finished allocation before anything was chosen.
 *
 * The caption under the chips is what keeps an illustration from reading as a suggestion,
 * and `isExamplePortfolio` is what carries that label onto the page once the example is
 * open (the holdings header shows the "Example" chip).
 *
 * `onReveal` shows the holdings pane and then runs the focus it is given. The pane is
 * collapsed on a phone, so the paste button has to open the pane before it can focus the
 * textarea inside it; the shell owns that state, so the card asks it rather than reaching
 * for it.
 */

import { write } from "@/lib/fragment-store";

import { EXAMPLE_ENTRIES, EXAMPLE_TICKERS } from "./example";
import { openPasteBox } from "./HoldingsPane";
import styles from "./Workspace.module.css";

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

/** The empty state: the card, the two ways in, and the funds the example holds. */
export function EmptyState({ onReveal }: { onReveal: (then?: () => void) => void }) {
  return (
    <section className="stack stack--loose" aria-labelledby="empty-heading">
      <div className="empty">
        <h2 id="empty-heading" className="empty__title">
          No holdings yet
        </h2>
        <p className="muted">Add a fund on the left, or start from an example.</p>
        <div className="row">
          <button type="button" className="btn btn--primary" onClick={loadExample}>
            Open the example
          </button>
          <button type="button" className="btn" onClick={() => onReveal(openPasteBox)}>
            Paste a list
          </button>
        </div>
        <ul className={styles.exampleRows}>
          {EXAMPLE_TICKERS.map((ticker) => (
            <li key={ticker}>
              <span className="chip chip--mono">{ticker}</span>
            </li>
          ))}
        </ul>
        <p className={styles.exampleLabel}>Example, not a recommendation.</p>
      </div>
    </section>
  );
}
