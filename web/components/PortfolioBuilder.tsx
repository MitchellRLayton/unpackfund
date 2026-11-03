"use client";

/**
 * The builder: one field, a list of what you hold, and the URL that is the portfolio.
 *
 * The field accepts three kinds of thing, because a portfolio contains three kinds of
 * thing: a fund ticker, a stock symbol, or cash. The release decides which is which —
 * a fund comes from its ticker list, a stock from its `securities/` object, and cash
 * is a button, because "CASH" is not a symbol anyone should have to guess (ADR-0014).
 *
 * The visitor also chooses how they think about the portfolio: **percentages** that
 * are shares of 100, or **dollars** that are the total by definition. The mode is
 * part of the URL, so a shared link reproduces the numbers that were typed rather
 * than a re-normalised version of them.
 *
 * The app never suggests a fund it cannot load, and never claims a stock exists in a
 * release that does not list it.
 *
 * The list is shown in the order the visitor gave it — typed order, then whatever they
 * dragged it into. Nothing here sorts: the order is theirs, it is stored in the URL
 * with the amounts (`fragment.ts`), and a reorder is a normal edit of that link.
 *
 * **Nothing rebalances the rows, and nothing clamps at 100%.** Amounts are entered one
 * row at a time, so a portfolio is short while it is being filled and past 100% for as
 * long as it takes to lower the next row; adjusting the rows the visitor did not touch
 * would rewrite numbers they did not edit. The tally states the total and whether it is
 * short or over, and "Open the X-Ray" waits for exactly 100% — a look-through weight
 * is a share of the whole, so the numbers behind that link only mean something once
 * there is a whole (2026-11-02, operator's instruction).
 *
 * **Adding a holding is not an edit to the holdings already there.** A new row arrives at
 * 0.00% and the amounts that were already typed are left alone; only a list that is still
 * the app's own even split keeps following its count (first fund 100%, second 50/50,
 * third 33.34/33.33/33.33). That is what `isEqualSplit` decides, and the notice a `kept`
 * add writes is the sentence that stops a 0.00% row from looking like a failed add.
 */

import Link from "next/link";
import { useCallback, useMemo, useState, type RefObject } from "react";

import { AmountInput } from "@/components/AmountInput";
import { Notice } from "@/components/Notice";
import { encodePortfolio } from "@/lib/fragment";
import {
  entryLabel,
  removeLabel,
  resolveEntry,
  tallyOf,
  type EntryDecision,
} from "@/lib/holdings";
import { formatCents, formatFundList, formatWeightBp } from "@/lib/format";
import { POPULAR_ORDER } from "@/lib/popular";
import { USD_NOTIONAL_CENTS } from "@/lib/portfolio-weights";
import { usePortfolio, type AddOutcome } from "@/lib/use-portfolio";
import { useRelease, useTickers } from "@/lib/use-release";
import { useReorderList, type ReorderList } from "@/lib/use-reorder";
import {
  CASH_KEY,
  type EntryKind,
  type EntryMode,
  type PortfolioEntry,
} from "@/lib/types";

/** The shared labels take a kind and a key; a row is an object, so wrap once. */
function labelOf(entry: PortfolioEntry): string {
  return entryLabel(entry.kind, entry.key);
}

function removeLabelOf(entry: PortfolioEntry): string {
  return removeLabel(entry.kind, entry.key);
}

/**
 * The rows themselves: one holding per row, with its amount field, its remove button
 * and its drag handle.
 *
 * A component rather than a block of JSX inside `PortfolioBuilder` for two reasons.
 * The plain one is that the builder had grown into a single function that rendered the
 * form, the mode control, the tally and the whole list, and this is the independent
 * piece. The load-bearing one is `react-hooks/refs` in this Next config: with the list
 * inline *and* the new awaited add path in the same function, the React Compiler
 * reports a false "Cannot access refs during render" on this `<ul>` — the ref is
 * `reorder.listRef`, which is a `ref` prop, never read. Splitting the list out puts it
 * in its own function and the diagnostic goes away without a suppression; a
 * `eslint-disable` would have hidden the rule for the real ref reads too.
 */
function HoldingList({
  entries,
  mode,
  reorder,
  listRef,
  onAmount,
  onRemove,
}: {
  entries: PortfolioEntry[];
  mode: EntryMode;
  reorder: ReorderList;
  /** The `<ul>` the drag maths measures rows from; the hook owns it, this renders it. */
  listRef: RefObject<HTMLUListElement | null>;
  onAmount: (entry: PortfolioEntry, amount: number) => void;
  onRemove: (kind: EntryKind, key: string) => void;
}) {
  return (
    <ul className="portfolio-list" ref={listRef}>
      {entries.map((entry, index) => (
        <li
          key={`${entry.kind}-${entry.key}`}
          className={reorder.draggingIndex === index ? "is-dragging" : undefined}
        >
          <button
            type="button"
            className="drag-handle"
            {...reorder.handleProps(index)}
            disabled={entries.length < 2}
            aria-label={`Reorder ${removeLabelOf(entry)}`}
            aria-describedby={entries.length > 1 ? "reorder-hint" : undefined}
            title="Drag to reorder"
          >
            <span aria-hidden="true">⠿</span>
          </button>
          <span className="portfolio-list__name">
            <span className="ticker">{labelOf(entry)}</span>
            {entry.kind === "security" ? (
              <span className="row-note">held directly</span>
            ) : null}
          </span>
          <AmountInput
            label={`Amount for ${labelOf(entry)}`}
            mode={mode}
            amount={entry.amount}
            onChange={(amount) => onAmount(entry, amount)}
          />
          <button
            type="button"
            className="quiet"
            onClick={() => onRemove(entry.kind, entry.key)}
            aria-label={`Remove ${removeLabelOf(entry)}`}
          >
            Remove
          </button>
        </li>
      ))}
    </ul>
  );
}

export function PortfolioBuilder() {
  const release = useRelease();
  const tickers = useTickers(release.status === "ready" ? release.data : null);
  const portfolio = usePortfolio();
  const moveHolding = useCallback(
    (from: number, to: number) => {
      const entry = portfolio.entries[from];
      if (!entry) return;
      // The store owns the order; this only names the row that moved.
      portfolio.move(entry.kind, entry.key, to);
    },
    [portfolio],
  );
  const reorder = useReorderList({
    count: portfolio.entries.length,
    labelAt: (index) => {
      const entry = portfolio.entries[index];
      return entry ? labelOf(entry) : "";
    },
    onMove: moveHolding,
  });
  const [input, setInput] = useState("");
  // A submit that has to wait for the alias map must not let a second Enter press
  // add the same holding twice; the button is disabled while it is in flight.
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<{
    tone: "warn" | "info";
    title: string;
    body?: string;
  } | null>(null);
  // The portfolio that "Remove all" just deleted, held only so the visitor can
  // put it back. It is never a second source of truth: the URL fragment was
  // already cleared, and Undo writes the old entries back through the same store.
  const [cleared, setCleared] = useState<{
    entries: PortfolioEntry[];
    mode: EntryMode;
  } | null>(null);
  // A mode switch re-expresses every amount, so it gets the same undo offer as a
  // clear: the split is unchanged, the numbers are not, and a reader deserves a way
  // back if the unit change was not what they meant.
  const [converted, setConverted] = useState<{
    entries: PortfolioEntry[];
    mode: EntryMode;
  } | null>(null);

  // Memoised because it is a dependency of the chip list: `tickers.status === "ready"
  // ? data : []` is a new array on every render, which would rebuild the chips
  // every time and defeat the filter.
  const catalog = useMemo(
    () => (tickers.status === "ready" ? tickers.data : []),
    [tickers.status, tickers.data],
  );
  const mode = portfolio.mode;
  // The ledger's numbers are shares of the whole, so the link into it is live only
  // when there is a whole. Dollars are their own total, so they always are.
  const ledgerOpen = mode === "usd" || portfolio.complete;

  /**
   * Every add path clears the undo offers: they belong to the portfolio they changed.
   *
   * Returns what the store did to the amounts already there. A row that arrives at
   * 0.00% while the portfolio is whole gets a sentence here: the operator asked for
   * exactly this (adding a fund must not move the weights they typed), and an add that
   * silently contributes nothing otherwise reads as an add that failed.
   */
  function addEntry(
    kind: EntryKind,
    key: string,
    body?: string,
    label?: string,
  ): AddOutcome {
    setCleared(null);
    setConverted(null);
    const outcome = portfolio.add(kind, key);
    if (outcome === "kept") {
      // `label` is what the reader should see the row called — a symbol resolved to its
      // company name keeps that promise here too, because this is the one path where the
      // add writes no amount and the title is carrying the whole confirmation.
      setMessage({
        tone: "info",
        title: `Added ${label ?? (kind === "cash" ? "cash" : key)} at 0.00%`,
        body: [
          body,
          "Your other rows kept the amounts you gave them. Set this row's amount to give it weight.",
        ]
          .filter(Boolean)
          .join(" "),
      });
    }
    return outcome;
  }

  /**
   * Empty the portfolio, keeping the old entries for one click.
   *
   * No confirm dialog: the design contract has no modal on this page, and a
   * dialog in front of a reversible action is friction with nothing behind it.
   * The offer to undo is the safety net, and it disappears the moment the
   * visitor adds something again.
   */
  function clearAll() {
    if (portfolio.entries.length === 0) return;
    setMessage(null);
    setCleared({ entries: portfolio.entries, mode });
    portfolio.clear();
  }

  function undoClear() {
    if (!cleared) return;
    portfolio.replace(cleared.entries);
    if (cleared.mode !== mode) portfolio.setMode(cleared.mode);
    setCleared(null);
  }

  function switchMode(next: EntryMode) {
    if (next === mode) return;
    setMessage(null);
    setConverted(
      portfolio.entries.length === 0
        ? null
        : { entries: portfolio.entries.map((entry) => ({ ...entry })), mode },
    );
    portfolio.setMode(next);
  }

  function undoConversion() {
    if (!converted) return;
    portfolio.setMode(converted.mode);
    setConverted(null);
  }

  // One statement of "is this list a whole", shared with Compare: the sentence, the
  // gate and the colour all read from the same numbers rather than re-deriving them.
  const tally = tallyOf(
    mode,
    portfolio.entries.map((entry) => entry.amount),
  );

  // The release publishes thousands of funds, so a list of them is useless as a
  // starting point: the first screen would be AAAA. These are the widely held ones,
  // in the operator's curated order, filtered to what this release can actually load.
  const chips = useMemo(
    () => POPULAR_ORDER.filter((ticker) => catalog.includes(ticker)).slice(0, 12),
    [catalog],
  );

  const shareHref = useMemo(() => {
    if (portfolio.entries.length === 0) return "/x/";
    return `/x/#${encodePortfolio({ mode, entries: portfolio.entries })}`;
  }, [mode, portfolio.entries]);

  /**
   * One typed line in, one row (or one refusal) out.
   *
   * Two functions, not one: `submit` stays a synchronous event handler that decides
   * whether to start, and `addTyped` is the async half that awaits the shared decision.
   * The split is not cosmetic — `react-hooks/refs` in this Next config reports a false
   * "ref accessed during render" on this component when the awaited call lives inside
   * the form handler itself, and the compiler cannot be argued with. Same behaviour,
   * same awaits, one frame earlier.
   *
   * The decision is `lib/holdings.resolveEntry`'s, not this component's: the Compare
   * page runs the same function, so the two pages cannot disagree about whether
   * `VFIAX` is addable, and a sentence written once is the sentence both show
   * (2026-11-02, the operator's "standardize the logic across these tables"). What
   * stays here is the part only this page has: the undo offers, which belong to the
   * portfolio they would change.
   */
  function submit(event: React.FormEvent) {
    event.preventDefault();
    const typed = input.trim();
    if (typed.length === 0 || adding) return;
    void addTyped(typed);
  }

  /** The add path's async half: one await, then a synchronous apply of the answer. */
  async function addTyped(typed: string) {
    setAdding(true);
    let decision: EntryDecision;
    try {
      decision = await resolveEntry(
        typed,
        { catalog, release, allowCash: true },
        portfolio.entries.map((entry) => entry.key),
      );
    } finally {
      setAdding(false);
    }
    apply(decision);
  }

  /**
   * Turn the shared decision into a row, or into the sentence that explains it.
   *
   * Synchronous on purpose: the await happens once, above, so this half only calls
   * setState and `addEntry`. It also keeps the JSX below simple enough for the React
   * Compiler's analysis — with the awaits interleaved the compiler reported a false
   * "ref accessed during render" on the holdings list.
   */
  function apply(decision: EntryDecision) {
    if (!decision.ok) {
      setMessage({ tone: decision.tone, title: decision.title, body: decision.body });
      return;
    }
    if (decision.kind === "cash") {
      const body = decision.body;
      if (addEntry("cash", CASH_KEY, body) !== "kept") {
        setMessage({ tone: "info", title: "Added cash", body });
      }
      setInput("");
      return;
    }
    if (decision.kind === "security") {
      // The confirmation step: a symbol is a label, and the reader sees the company
      // the release resolved it to before it enters their portfolio.
      if (
        addEntry("security", decision.key, decision.body, decision.resolved) !== "kept"
      ) {
        setMessage({
          tone: "info",
          title: `Added ${decision.resolved ?? decision.key}`,
          body: decision.body,
        });
      }
      setInput("");
      return;
    }
    // A fund this release publishes, or a share class of one (which `resolveEntry` has
    // already turned into the published ticker and the note that says so).
    const outcome = addEntry("fund", decision.key, decision.body);
    setInput("");
    if (outcome !== "kept" && outcome !== "noop") {
      setMessage(
        decision.body
          ? { tone: "info", title: `Added ${decision.key}`, body: decision.body }
          : { tone: "info", title: `Added ${decision.key}` },
      );
    }
  }

  /**
   * Set one row's amount, exactly as typed.
   *
   * The only ceiling left is a single row's own (100% in percent mode, $1bn in
   * dollars), which the store enforces because a row above the whole is not a number
   * any view can use. The portfolio's total is not clamped and no other row moves:
   * overshooting is a normal step on the way to a total, and the tally says so.
   */
  function setEntryAmount(entry: PortfolioEntry, amount: number) {
    setMessage(null);
    portfolio.setAmount(entry.kind, entry.key, amount);
  }

  function addFund(ticker: string, body?: string) {
    const outcome = addEntry("fund", ticker, body);
    setInput("");
    // `kept` already wrote a sentence naming the 0.00% row; anything else is a plain
    // "Added", with the share-class note when there is one.
    if (outcome !== "kept") {
      setMessage(
        body
          ? { tone: "info", title: `Added ${ticker}`, body }
          : { tone: "info", title: `Added ${ticker}` },
      );
    }
  }

  return (
    <>
      <h1>See the companies behind your funds</h1>
      <p className="prose">
        Enter what you hold — fund tickers, stock symbols, and cash. UnpackFund reads each
        fund&apos;s most recent SEC N-PORT filing, maps every holding to one company, and
        adds your direct positions into the same list, so a company appears once.
      </p>

      {portfolio.problem ? (
        <Notice tone="warn" title="That link could not be opened">
          {portfolio.problem}
        </Notice>
      ) : null}

      <form onSubmit={submit} className="field" noValidate>
        <label htmlFor="ticker" className="sr-only">
          Fund ticker or stock symbol
        </label>
        <input
          id="ticker"
          type="text"
          name="ticker"
          placeholder={
            chips.length > 0
              ? `Ticker or symbol, e.g. ${chips[0]} or AMZN`
              : "Ticker or symbol"
          }
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={10}
          value={input}
          aria-describedby="ticker-hint"
          onChange={(event) => {
            setInput(event.target.value.toUpperCase());
            setMessage(null);
          }}
        />
        <button type="submit" className="primary" disabled={adding}>
          Add
        </button>
        <button
          type="button"
          onClick={() => {
            setMessage(null);
            addEntry("cash", CASH_KEY);
          }}
          disabled={portfolio.entries.some((entry) => entry.kind === "cash")}
        >
          Add cash
        </button>
      </form>
      <p
        id="ticker-hint"
        className="muted"
        style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}
      >
        {release.status === "ready"
          ? catalog.length > 40
            ? // Thousands of tickers do not belong in a hint line; the count is the
              // useful fact, and typing a ticker is the interaction the field is for.
              `Release ${release.data.as_of} publishes ${catalog.length.toLocaleString("en-US")} funds and ${release.data.objects.securities ? release.data.objects.securities.count.toLocaleString("en-US") : "no"} listed stock symbols. Type either, or cash.`
            : `Release ${release.data.as_of} publishes ${catalog.length} ${catalog.length === 1 ? "fund" : "funds"}: ${formatFundList(catalog)}.`
          : release.status === "loading" || tickers.status === "loading"
            ? "Reading the release pointer…"
            : "The release pointer could not be read."}
      </p>

      {chips.length > 0 ? (
        <div className="chips-row">
          <span className="muted">Popular</span>
          <ul className="chips">
            {chips.map((ticker) => (
              <li key={ticker}>
                <button
                  type="button"
                  onClick={() => addFund(ticker)}
                  disabled={portfolio.entries.some(
                    (entry) => entry.kind === "fund" && entry.key === ticker,
                  )}
                  aria-label={`Add ${ticker}`}
                >
                  {ticker}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {message ? (
        <Notice
          tone={message.tone === "warn" ? "warn" : "accent"}
          title={message.title}
          role="status"
        >
          {message.body ? <p className="muted">{message.body}</p> : null}
        </Notice>
      ) : null}

      {cleared ? (
        <Notice tone="accent" title="Portfolio cleared" role="status">
          <p>
            Removed {cleared.entries.length}{" "}
            {cleared.entries.length === 1 ? "holding" : "holdings"}. Undo puts them back
            exactly as they were, amounts included.{" "}
            <button type="button" className="quiet" onClick={undoClear}>
              Undo
            </button>
          </p>
        </Notice>
      ) : null}

      {converted ? (
        <Notice
          tone="accent"
          title={`Amounts shown in ${mode === "usd" ? "dollars" : "percent"}`}
          role="status"
        >
          <p>
            {converted.mode === "bp"
              ? `Your percentages became dollars of a ${formatCents(USD_NOTIONAL_CENTS)} portfolio ($1.00 per 1%).`
              : "Your dollars became percentages of their total."}{" "}
            The split is unchanged.{" "}
            <button type="button" className="quiet" onClick={undoConversion}>
              Undo
            </button>
          </p>
        </Notice>
      ) : null}

      {portfolio.entries.length > 0 ? (
        <>
          <h2>Your portfolio</h2>

          {portfolio.entries.length > 1 ? (
            <p className="muted reorder-hint" id="reorder-hint">
              Drag a handle — or focus it and press the up and down arrow keys — to change
              the order.
            </p>
          ) : null}
          <p className="sr-only" role="status" aria-live="polite">
            {reorder.announcement}
          </p>

          <div
            className="mode-toggle"
            role="group"
            aria-label="How your amounts are entered"
          >
            <button
              type="button"
              aria-pressed={mode === "bp"}
              className={mode === "bp" ? "primary" : undefined}
              onClick={() => switchMode("bp")}
            >
              Percentages
            </button>
            <button
              type="button"
              aria-pressed={mode === "usd"}
              className={mode === "usd" ? "primary" : undefined}
              onClick={() => switchMode("usd")}
            >
              Dollars
            </button>
            <span className="muted">
              {mode === "bp"
                ? "Percentages must add up to 100% for the X-Ray."
                : "Dollars are the total — no need to reach any figure."}
            </span>
          </div>

          <HoldingList
            entries={portfolio.entries}
            mode={mode}
            reorder={reorder}
            listRef={reorder.listRef}
            onAmount={setEntryAmount}
            onRemove={portfolio.remove}
          />

          <p className="tally" role="status">
            <span>
              Total{" "}
              <span className="tally__value">
                {mode === "bp"
                  ? formatWeightBp(portfolio.total)
                  : formatCents(portfolio.total)}
              </span>
            </span>
            <span className="muted">
              {mode === "bp"
                ? tally.sentence
                : `${portfolio.entries.length} ${portfolio.entries.length === 1 ? "holding" : "holdings"}`}
            </span>
            {mode === "bp" ? (
              <button
                type="button"
                className="quiet"
                onClick={() => portfolio.equalise()}
              >
                Split equally
              </button>
            ) : null}
            <button
              type="button"
              className="quiet"
              onClick={clearAll}
              aria-label="Remove everything from the portfolio"
            >
              Remove all
            </button>
            <Link
              href={shareHref}
              className="tally__go"
              aria-disabled={ledgerOpen ? undefined : true}
              aria-describedby={ledgerOpen ? undefined : "ledger-gate"}
              onClick={(event) => {
                // A link that is inert but still focusable: a removed or `disabled`
                // control takes its explanation with it, and this explanation is a
                // sentence the visitor can act on (lower a row, or switch to dollars).
                if (!ledgerOpen) event.preventDefault();
              }}
            >
              Open the X-Ray
            </Link>
            {/* The sentence the operator asked to colour (2026-11-02): red while the
             * portfolio is not whole, green once it is. Rendered in both states and in
             * percent mode only — in dollars the link is always live, and a sentence
             * about 100% would be describing a rule that does not apply. `muted` keeps
             * the type; the state class overrides the ink. */}
            {mode === "usd" ? null : (
              <span
                className={`muted tally__gate ${
                  ledgerOpen ? "tally__gate--open" : "tally__gate--locked"
                }`}
                id="ledger-gate"
              >
                The X-Ray opens at exactly 100%.
              </span>
            )}
          </p>
          <CopyLink href={shareHref} />
        </>
      ) : (
        <p className="muted">
          Nothing added yet. The portfolio lives in this page&apos;s URL, so a link
          reproduces it exactly.
        </p>
      )}
    </>
  );
}

/** Copy the current URL — the only sharing mechanism, and it needs no service. */
function CopyLink({ href }: { href: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <p style={{ marginTop: "0.5rem" }}>
      <button
        type="button"
        onClick={async () => {
          const url = `${window.location.origin}${href}`;
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "Copied" : "Copy link to this portfolio"}
      </button>{" "}
      <span className="muted sr-only" role="status">
        {copied ? "Link copied to the clipboard." : ""}
      </span>
    </p>
  );
}
