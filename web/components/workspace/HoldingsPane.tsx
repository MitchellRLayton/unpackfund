"use client";

/**
 * The holdings pane: the portfolio, in the left column, as rows you can weigh.
 *
 * This replaces the old `/` builder. It does the same job — add a fund, a stock or cash;
 * set an amount; see the total — and adds what the redesign asked of it: a ranked
 * suggestion list, a paste box that reads a whole list, the coverage and filing chips
 * that keep a number honest, drag-and-keyboard reordering, and the two ways of closing
 * a partial portfolio (fill the rest with cash, or scale what is here to 100%).
 *
 * Three rules shape the code:
 *
 * 1. **The store is the only source of truth.** Amounts, order and mode live in the URL
 *    fragment; this file holds drafts (a half-typed amount, the text in the add field)
 *    and nothing else. No `useEffect` copies one into the other.
 * 2. **A write that changes two things is one write.** Adding to a portfolio the app
 *    spread evenly re-splits every row, so "add" and "set an amount" are never chained:
 *    each of those paths builds the entry list itself and calls `replace` once. Two
 *    writes in one handler would read a stale closure and drop a row.
 * 3. **A number never appears without its qualifier.** Every fund row carries its
 *    coverage band and the reporting period it came from (`lookthrough-math-and-qa`
 *    §5); a fund whose coverage is below 60% says so in the row, not in a footnote.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  MAX_HOLDINGS,
  CASH_KEY,
  entryLabel,
  removeLabel,
  resolveEntry,
  tallyOf,
  type EntryDecision,
} from "@/lib/holdings";
import { write } from "@/lib/fragment-store";
import {
  ATTRIBUTED_LABEL,
  COVERAGE_POPOVER,
  IDENTIFIED_LABEL,
  coverageChipText,
  coveragePair,
  coverageSentence,
  coverageSleeve,
  sleeveLine,
  sleeveShowsIdentified,
} from "@/lib/coverage";
import {
  coverageBand,
  formatCents,
  formatCount,
  formatCoveragePct,
  formatDateLong,
  formatWeightBp,
} from "@/lib/format";
import { useReorderList, type ReorderList } from "@/lib/use-reorder";
import { rankFunds } from "@/lib/search";
import { useCatalogue, useTickers } from "@/lib/use-release";
import type { EntryMode, EntryKind, FundDocument, PortfolioEntry } from "@/lib/types";
import type { WorkspaceModel } from "@/lib/use-workspace";

import { InfoTip } from "@/components/feedback/InfoTip";
import { Term } from "@/components/prose/Term";

import { EXAMPLE_LABEL, isExamplePortfolio } from "./example";
import { parsePaste, previewCounts, previewPaste, type PasteLine } from "./paste";
import { scaleToWhole } from "./total";
import styles from "./Workspace.module.css";

/** The add field's id, and the paste disclosure's: the empty card focuses the paste box. */
export const ADD_INPUT_ID = "add-holding";
/** The paste disclosure, for the empty state's "Paste a list" button. */
export const PASTE_ID = "paste-holdings";
const PASTE_TEXTAREA_ID = "paste-holdings-text";
const SUGGEST_ID = "add-suggestions";

/** How long the transient status after a switch to dollars stays up. */
const STATUS_MS = 5_000;

/** What that status says: what happened, and the scale it happened on. */
const DOLLARS_STATUS = "Switched to dollars, scaled to $10,000.";

/** The example's chip in the holdings header, and the tip that qualifies it. */
const EXAMPLE_CHIP = "Example";

/** Open the paste box and put the caret in it. */
export function openPasteBox(): void {
  const box = document.getElementById(PASTE_ID);
  if (box instanceof HTMLDetailsElement) box.open = true;
  const area = document.getElementById(PASTE_TEXTAREA_ID);
  if (area instanceof HTMLTextAreaElement) area.focus();
}

/** What the pane is saying under the field: a refusal, a confirmation, or an undo. */
interface Message {
  tone: "warn" | "info";
  title: string;
  body?: string;
  undo?: () => void;
}

interface Suggestion {
  id: string;
  label: string;
  detail: string;
  kind: "cash" | "fund";
}

/**
 * An allocation line's first word, capitalised.
 *
 * The line used to trail a lead sentence ("Percentages are shares of one whole."), so
 * `tallyOf` writes its half in lower case ("fully allocated"). The lead sentence is gone and
 * the tally now opens the line, so its first letter is raised here — the case of one letter,
 * with the words and the figures still owned by `tallyOf`.
 */
function lineStart(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * The amount field: percent in `%` mode, dollars in `$` mode.
 *
 * The draft string is local so a half-typed "12." never round-trips through the URL as
 * 12. Both units are stored as hundredths (basis points, cents), so the parse is the
 * same multiply in both modes; only the ceiling and the suffix differ.
 */
function AmountField({
  label,
  mode,
  amount,
  onChange,
}: {
  label: string;
  mode: "bp" | "usd";
  amount: number;
  onChange: (amount: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? (amount / 100).toFixed(2);

  const commit = (text: string) => {
    const cleaned = text.replace(/[^0-9.]/g, "");
    const parsed = Number(cleaned);
    setDraft(null);
    if (cleaned.length === 0 || !Number.isFinite(parsed)) return;
    const ceiling = mode === "bp" ? 100 : 1_000_000;
    const clamped = Math.max(0, Math.min(ceiling, parsed));
    onChange(Math.round(clamped * 100));
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      className={`field__input ${styles.amountInput}`}
      aria-label={mode === "bp" ? `${label}, in percent` : `${label}, in dollars`}
      value={value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => commit(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit(event.currentTarget.value);
        } else if (event.key === "Escape") {
          setDraft(null);
        }
      }}
    />
  );
}

/**
 * One chip per qualifier: coverage, reporting period, or what kind of row this is.
 *
 * Coverage is two shares for a fund, not one, and the row carries both when the release
 * measures both (`lib/coverage.ts` is the only place that decides). Attribution — the
 * share tied to a named company — keeps the chip and the band, because it is the number
 * every figure downstream depends on. Identification, the share whose *security* is
 * known, is a weaker test and therefore the larger number; it gets a quiet chip and a
 * label that names the quantity, so it cannot be read as company coverage. A release
 * without `identified_pct` renders exactly the one chip it rendered before.
 */
function RowChips({ entry, model }: { entry: PortfolioEntry; model: WorkspaceModel }) {
  if (entry.kind === "security") {
    return <span className="chip chip--mono">held directly</span>;
  }
  if (entry.kind === "cash") {
    return <span className="chip">no company behind it</span>;
  }
  const fund = model.fundByTicker.get(entry.key);
  if (!fund) {
    // The row already says "Reading filing…" beside the ticker, so this slot is a bar
    // with no words: the same sentence twice is a stutter, not a second fact.
    return <span className={styles.chipSkeleton} aria-hidden="true" />;
  }
  const pair = coveragePair(fund);
  return (
    <>
      <span
        className={`chip chip--${coverageBand(fund.coverage_pct)}`}
        title={
          pair.identified === null
            ? undefined
            : "Attribution: the share of this fund's weight tied to a named company. The dashed figure beside it is the share we can identify as a security, which is a weaker test and is not company coverage."
        }
      >
        {pair.identified === null
          ? coverageChipText(fund.coverage_pct)
          : `${formatCoveragePct(pair.attributed)} ${ATTRIBUTED_LABEL}`}
        {pair.identified === null ? (
          <InfoTip label="Coverage">{COVERAGE_POPOVER}</InfoTip>
        ) : null}
      </span>
      {pair.identified === null ? null : (
        <span
          className="chip chip--identified"
          title={coverageSentence(pair.attributed, pair.identified)}
        >
          {formatCoveragePct(pair.identified)} {IDENTIFIED_LABEL}
        </span>
      )}
      <span className="chip chip--date">
        {formatDateLong(fund.as_of)}
        <InfoTip label="Holdings date">
          {`Holdings as of ${formatDateLong(fund.as_of)} · filed ${formatDateLong(
            fund.filed_at,
          )} (${fund.lag_days} days later)`}
        </InfoTip>
      </span>
    </>
  );
}

/**
 * The classes of one fund, under its row: the same two shares, per asset class.
 *
 * The portfolio strip answers "how much of my money is attributed"; this line answers
 * "and in which kind of holding is the rest". It is the only place the per-class figures
 * appear, and it prints nothing at all unless the release measures identification and at
 * least one class shows a different number on each side — a sleeve whose two columns
 * agree would be a second printing of the row's own chip.
 */
function FundSleeveNote({ fund }: { fund: FundDocument | undefined }) {
  if (!fund) return null;
  const sleeve = coverageSleeve(fund).filter((row) => row.attributed !== null);
  if (!sleeveShowsIdentified(sleeve)) return null;
  return (
    <span className={`small muted ${styles.rowSleeve}`}>
      {sleeve.map(sleeveLine).join("; ")}
    </span>
  );
}

/**
 * The rows, in their own function.
 *
 * Not a style choice: `react-hooks/refs` in this Next config reports a false "Cannot
 * access refs during render" when a `ref` prop and an awaited path share one function, and
 * the add flow here awaits the release. `PortfolioBuilder` hit the same diagnostic and
 * solved it the same way — the list becomes a component, so the ref it takes is an ordinary
 * prop and the rule keeps working for the reads that are real. An `eslint-disable` would
 * have hidden the rule for those too.
 */
function HoldingRows({
  model,
  mode,
  entries,
  reorder,
  onAmount,
  onRemove,
  onRemoveAll,
}: {
  model: WorkspaceModel;
  mode: EntryMode;
  entries: PortfolioEntry[];
  reorder: ReorderList;
  onAmount: (entry: PortfolioEntry, amount: number) => void;
  onRemove: (kind: EntryKind, key: string) => void;
  onRemoveAll: () => void;
}) {
  // The ref and the live-region text are read here, never in the caller: `HoldingsPane`
  // awaits the release, and `react-hooks/refs` reports a false "Cannot access refs during
  // render" when a ref prop and an awaited path share one function body (`PortfolioBuilder`
  // documents the same diagnostic). Its render never touches a field of this object.
  const { listRef, draggingIndex, announcement, handleProps } = reorder;
  return (
    <>
      <ul className={styles.rows} ref={listRef}>
        {entries.map((entry, index) => (
          <li
            key={`${entry.kind}:${entry.key}`}
            className={`${styles.rowItem}${
              draggingIndex === index ? ` ${styles.dragging}` : ""
            }`}
          >
            <button
              type="button"
              className={styles.handle}
              {...handleProps(index)}
              disabled={entries.length < 2}
              aria-label={`Reorder ${removeLabel(entry.kind, entry.key)}`}
              title="Drag to reorder, or use the arrow keys"
            >
              <span aria-hidden="true">⠿</span>
            </button>
            <div className={styles.rowMain}>
              <span className={`mono ${styles.rowName}`}>
                {entryLabel(entry.kind, entry.key)}
              </span>
              {entry.kind === "fund" ? (
                <span className={`small muted ${styles.rowName}`}>
                  {model.fundByTicker.get(entry.key)?.name ?? "Reading filing…"}
                </span>
              ) : null}
              <div className={styles.rowSub}>
                <RowChips entry={entry} model={model} />
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  onClick={() => onRemove(entry.kind, entry.key)}
                  aria-label={`Remove ${removeLabel(entry.kind, entry.key)}`}
                >
                  Remove
                </button>
              </div>
              {entry.kind === "fund" ? (
                <FundSleeveNote fund={model.fundByTicker.get(entry.key)} />
              ) : null}
            </div>
            <AmountField
              label={`Amount for ${entryLabel(entry.kind, entry.key)}`}
              mode={mode}
              amount={entry.amount}
              onChange={(amount) => onAmount(entry, amount)}
            />
          </li>
        ))}
      </ul>
      <p role="status" className="visually-hidden">
        {announcement}
      </p>
      <div className={styles.helpers}>
        <button type="button" className="btn btn--quiet btn--sm" onClick={onRemoveAll}>
          Remove all
        </button>
      </div>
    </>
  );
}

export function HoldingsPane({
  model,
  onCollapse,
}: {
  model: WorkspaceModel;
  /** Present when the pane can shrink to the compact list. Absent on a phone, where
   * the chip bar above it is already the compact list. */
  onCollapse?: () => void;
}) {
  const { portfolio } = model;
  const releaseData = model.release.status === "ready" ? model.release.data : null;
  const tickers = useTickers(releaseData);
  // The catalogue is the fund-name and issuer index behind the suggestions, and it is
  // a megabyte. It is fetched when the add field is first used, not on page load: the
  // ticker list (113 KB) is what `resolveEntry` needs to decide anything, and this is
  // only for showing names while the visitor types.
  const [wantsSuggestions, setWantsSuggestions] = useState(false);
  const catalogue = useCatalogue(wantsSuggestions ? releaseData : null);

  const [input, setInput] = useState("");
  const [active, setActive] = useState(-1);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  /**
   * The one-line status after a switch to dollars. It is not the `message` box: the box is
   * an answer that stays until the next action (a refusal, or a confirmation with an undo),
   * and this is a statement that has done its job the moment it is read — so it is a polite
   * status that clears after five seconds or on the next edit.
   */
  const [modeStatus, setModeStatus] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [pasting, setPasting] = useState(false);

  useEffect(() => {
    if (modeStatus === null) return;
    const timer = window.setTimeout(() => setModeStatus(null), STATUS_MS);
    return () => window.clearTimeout(timer);
  }, [modeStatus]);

  const entries = portfolio.entries;
  const mode = portfolio.mode;
  /**
   * The example's own portfolio, once it has been opened. It is labelled in the header,
   * beside the row count, because that is where a reader looks to see what is in the pane
   * — an illustration labelled below the page is labelled after it has been read.
   */
  const isExample = isExamplePortfolio(mode, entries);
  const present = useMemo(() => entries.map((entry) => entry.key), [entries]);
  const tally = tallyOf(
    mode,
    entries.map((entry) => entry.amount),
  );
  /** A percentage portfolio is whole when it accounts for exactly 100% of itself. */
  const whole = mode === "bp" && tally.ok;

  const catalog = useMemo(
    () => (tickers.status === "ready" ? (tickers.data ?? []) : []),
    [tickers],
  );

  const suggestions = useMemo<Suggestion[]>(() => {
    const query = input.trim();
    if (query.length === 0) return [];
    const found: Suggestion[] = [];
    if ("cash".startsWith(query.toLowerCase())) {
      found.push({
        id: CASH_KEY,
        label: "Cash",
        detail: "the part of your money with no company behind it",
        kind: "cash",
      });
    }
    const funds = rankFunds(
      query,
      catalogue.status === "ready" ? catalogue.data : null,
      6,
    );
    for (const hit of funds) {
      found.push({ id: hit.id, label: hit.label, detail: hit.detail, kind: "fund" });
    }
    return found;
  }, [input, catalogue]);

  const open = suggestions.length > 0 && input.trim().length > 0;

  const moveEntry = useCallback(
    (from: number, to: number) => {
      const entry = portfolio.entries[from];
      if (entry) portfolio.move(entry.kind, entry.key, to);
    },
    [portfolio],
  );
  const reorder = useReorderList({
    count: entries.length,
    labelAt: (index) => {
      const entry = entries[index];
      return entry ? entryLabel(entry.kind, entry.key) : "";
    },
    onMove: moveEntry,
  });

  /**
   * Turn one typed line into a row.
   *
   * The release decides what the line is (`resolveEntry`), and the sentence it returns
   * is shown as-is: the same words `/compare` would use, because the decision is one
   * module's. `add` is called once and never chained with `setAmount` — see rule 2 in
   * the module comment.
   */
  const addTyped = useCallback(
    async (raw: string) => {
      if (tickers.status !== "ready") {
        setMessage({
          tone: "info",
          title: "Still reading the fund list",
          body: "The release has not published its tickers yet. One moment.",
        });
        return;
      }
      setAdding(true);
      const decision: EntryDecision = await resolveEntry(
        raw,
        { catalog, release: model.release, where: "your portfolio" },
        present,
      );
      setAdding(false);
      if (!decision.ok) {
        setMessage({ tone: decision.tone, title: decision.title, body: decision.body });
        return;
      }
      setInput("");
      setActive(-1);
      const outcome = portfolio.add(decision.kind, decision.key);
      if (outcome === "noop") {
        setMessage({
          tone: "info",
          title: `${decision.label} is already in your portfolio`,
          body: "One row per holding: set its amount instead of adding it twice.",
        });
        return;
      }
      setMessage({
        tone: "info",
        title:
          decision.kind === "cash"
            ? "Cash added"
            : `${decision.label} added${decision.resolved ? ` — ${decision.resolved}` : ""}`,
        body:
          decision.body ??
          (outcome === "split"
            ? "The app spread the whole evenly across the rows; set the amounts to your own."
            : "Set its amount. It arrived at 0.00% so nothing was assumed about your money."),
      });
    },
    [catalog, model.release, portfolio, present, tickers.status],
  );

  /**
   * Apply the paste box: one write, every line resolved first.
   *
   * The lines are resolved one at a time (each may need the release's alias map or a
   * securities shard), and only then is the list written — so a paste that half-fails
   * adds the lines that worked and names the ones that did not, instead of leaving the
   * portfolio in a state nobody chose.
   */
  const applyPaste = useCallback(async () => {
    const lines = previewPaste(parsePaste(pasteText), mode);
    const usable = lines.filter((line) => !line.problem);
    if (usable.length === 0) return;
    if (tickers.status !== "ready") {
      setMessage({
        tone: "info",
        title: "Still reading the fund list",
        body: "The release has not published its tickers yet. One moment.",
      });
      return;
    }
    setPasting(true);
    const additions: PortfolioEntry[] = [];
    const problems: string[] = [];
    const taken = new Set(present);
    for (const line of usable) {
      if (entries.length + additions.length >= MAX_HOLDINGS) {
        problems.push(`The portfolio holds at most ${formatCount(MAX_HOLDINGS)} rows.`);
        break;
      }
      const decision = await resolveEntry(
        line.label === "Cash" ? "cash" : line.label,
        { catalog, release: model.release, where: "your portfolio", allowCash: true },
        [...taken],
      );
      if (!decision.ok) {
        problems.push(`${line.label}: ${decision.title}`);
        continue;
      }
      taken.add(decision.key);
      additions.push({ kind: decision.kind, key: decision.key, amount: line.amount });
    }
    setPasting(false);
    if (additions.length > 0) {
      portfolio.replace([...entries, ...additions]);
      setPasteText("");
    }
    setMessage({
      tone: problems.length > 0 ? "warn" : "info",
      title:
        additions.length === 0
          ? "Nothing from the paste could be added"
          : `Added ${formatCount(additions.length)} ${
              additions.length === 1 ? "holding" : "holdings"
            }`,
      body:
        problems.length > 0
          ? problems.join(" ")
          : "Check the amounts against your own split before sharing the link.",
    });
  }, [
    catalog,
    entries,
    mode,
    model.release,
    pasteText,
    portfolio,
    present,
    tickers.status,
  ]);

  /** Give the unallocated remainder to cash, in one write. */
  const fillWithCash = useCallback(() => {
    if (portfolio.unallocatedBp <= 0) return;
    const existing = entries.find((entry) => entry.kind === "cash");
    if (existing) {
      portfolio.replace(
        entries.map((entry) =>
          entry.kind === "cash" && entry.key === CASH_KEY
            ? { ...entry, amount: entry.amount + portfolio.unallocatedBp }
            : entry,
        ),
      );
      return;
    }
    portfolio.replace([
      ...entries,
      { kind: "cash", key: CASH_KEY, amount: portfolio.unallocatedBp },
    ]);
  }, [entries, portfolio]);

  /**
   * Spread the whole evenly across every row, whatever their amounts are now.
   *
   * The same split a fresh portfolio receives (`equalise`), offered as a button because
   * a set the visitor weighted by hand is never re-spread automatically: after hand
   * edits this is the way back to equal weights. Percent mode only — in dollars the
   * amounts are the visitor's money, and `equalise` writes nothing there.
   */
  const equalWeights = useCallback(() => {
    if (entries.length === 0) return;
    portfolio.equalise();
    setMessage({
      tone: "info",
      title: "Equal weights",
      body: "Every holding now carries the same share of the whole; the amounts add up to exactly 100.00%.",
    });
  }, [entries.length, portfolio]);

  /** Rescale every row so the set totals exactly 100%, keeping its proportions. */
  const scaleToHundred = useCallback(() => {
    if (entries.length === 0) return;
    const scaled = scaleToWhole(entries.map((entry) => entry.amount));
    portfolio.replace(
      entries.map((entry, index) => ({ ...entry, amount: scaled[index] ?? 0 })),
    );
    setMessage({
      tone: "info",
      title: "Scaled to 100%",
      body: "Every row kept its share of the others; only the unit changed.",
    });
  }, [entries, portfolio]);

  const removeAll = useCallback(() => {
    if (entries.length === 0) return;
    const previous = entries;
    portfolio.clear();
    setMessage({
      tone: "info",
      title: "Portfolio cleared",
      body: "The address bar no longer carries these holdings.",
      undo: () => {
        portfolio.replace(previous);
        setMessage(null);
      },
    });
  }, [entries, portfolio]);

  const changeMode = useCallback(
    (next: "bp" | "usd") => {
      if (next === mode) return;
      portfolio.setMode(next);
      if (next === "usd") {
        // A statement about what just happened, not a description of the screen: it is
        // rendered as a polite status and clears itself, so it cannot be mistaken for a
        // standing note about the numbers below it.
        setMessage(null);
        setModeStatus(DOLLARS_STATUS);
        return;
      }
      setMessage({
        tone: "info",
        title: "Amounts in percent",
        body: "The same split, re-expressed as shares of your total.",
      });
    },
    [mode, portfolio],
  );

  const pasteLines = useMemo(
    () =>
      pasteText.trim().length === 0 ? [] : previewPaste(parsePaste(pasteText), mode),
    [pasteText, mode],
  );
  const pasteCounts = previewCounts(pasteLines);

  return (
    <section className="panel" aria-labelledby="holdings-heading">
      <div className="panel__head">
        <h2 id="holdings-heading" className="panel__title">
          Your holdings
        </h2>
        <div className={styles.helpers}>
          <span className="small muted">
            {formatCount(entries.length)} of {formatCount(MAX_HOLDINGS)}
          </span>
          {isExample ? (
            <span className="chip">
              {EXAMPLE_CHIP}
              <InfoTip label="Example">{EXAMPLE_LABEL}</InfoTip>
            </span>
          ) : null}
          {onCollapse ? (
            <button
              type="button"
              className={`btn btn--sm ${styles.collapseControl}`}
              aria-expanded={true}
              aria-controls="holdings-pane-region"
              onClick={onCollapse}
            >
              Collapse
            </button>
          ) : null}
          <div className={styles.mode} role="group" aria-label="How amounts are entered">
            <button
              type="button"
              className={`${styles.modeBtn}${mode === "bp" ? ` ${styles.modeBtnOn}` : ""}`}
              aria-pressed={mode === "bp"}
              onClick={() => changeMode("bp")}
            >
              Percent
            </button>
            <button
              type="button"
              className={`${styles.modeBtn}${mode === "usd" ? ` ${styles.modeBtnOn}` : ""}`}
              aria-pressed={mode === "usd"}
              onClick={() => changeMode("usd")}
            >
              Dollars
            </button>
          </div>
        </div>
      </div>

      <div className="panel__body stack">
        <form
          className="field"
          onSubmit={(event) => {
            event.preventDefault();
            const raw = input.trim();
            if (raw.length === 0) return;
            void addTyped(raw);
          }}
        >
          <label className="field__label" htmlFor={ADD_INPUT_ID}>
            Add a fund, a stock, or cash
          </label>
          <div className={styles.addRow}>
            <input
              id={ADD_INPUT_ID}
              className={`field__input ${styles.addInput}`}
              type="text"
              role="combobox"
              aria-expanded={open}
              aria-controls={open ? SUGGEST_ID : undefined}
              aria-autocomplete="list"
              aria-activedescendant={
                open && active >= 0 ? `${SUGGEST_ID}-${active}` : undefined
              }
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={40}
              placeholder="Ticker, fund, issuer, or “cash”"
              value={input}
              onFocus={() => setWantsSuggestions(true)}
              onChange={(event) => {
                setInput(event.target.value);
                setActive(-1);
                setMessage(null);
                setModeStatus(null);
                setWantsSuggestions(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" && suggestions.length > 0) {
                  event.preventDefault();
                  setActive((index) => Math.min(suggestions.length - 1, index + 1));
                } else if (event.key === "ArrowUp" && suggestions.length > 0) {
                  event.preventDefault();
                  setActive((index) => Math.max(-1, index - 1));
                } else if (event.key === "Escape") {
                  setActive(-1);
                } else if (event.key === "Enter" && active >= 0) {
                  const suggestion = suggestions[active];
                  if (suggestion) {
                    event.preventDefault();
                    setInput("");
                    setActive(-1);
                    void addTyped(suggestion.id);
                  }
                }
              }}
            />
            <button type="submit" className="btn btn--primary" disabled={adding}>
              {adding ? "Adding…" : "Add"}
            </button>
          </div>
          {open ? (
            <ul
              className="suggest"
              id={SUGGEST_ID}
              role="listbox"
              aria-label="Suggestions"
            >
              {suggestions.map((suggestion, index) => (
                <li
                  key={`${suggestion.kind}:${suggestion.id}`}
                  id={`${SUGGEST_ID}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className="suggest__item"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    setInput("");
                    setActive(-1);
                    void addTyped(suggestion.id);
                  }}
                >
                  <span className="suggest__ticker mono">{suggestion.label}</span>
                  <span className="suggest__name">{suggestion.detail}</span>
                  <span className="suggest__meta">
                    {suggestion.kind === "cash" ? "cash" : "fund"}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </form>

        <details id={PASTE_ID}>
          {/* `.field` is a flex column, so it wraps the body rather than the `<details>`:
              on the disclosure itself it would lay the summary out beside the textarea. */}
          <summary className="small muted">Paste a list</summary>
          <div className="field">
            <p className="field__hint">
              One per line, like <span className="mono">VTI 40%</span> or{" "}
              <span className="mono">VXUS $12,000</span>. A bare number is a percent.
            </p>
            <textarea
              id={PASTE_TEXTAREA_ID}
              aria-label="Holdings to paste, one per line"
              placeholder={"VTI 40%\nVXUS 30%\nBND 30%"}
              value={pasteText}
              onChange={(event) => {
                setPasteText(event.target.value);
                setModeStatus(null);
              }}
            />
            {pasteLines.length > 0 ? (
              <ul className={styles.pastePreview} aria-label="What the paste will add">
                {pasteLines.map((line: PasteLine, index) => (
                  <li
                    key={`${line.raw}-${index}`}
                    className={`${styles.pasteLine} ${line.problem ? styles.pasteBad : styles.pasteOk}`}
                  >
                    <span className="mono">{line.label}</span>
                    <span>{line.problem ?? line.amountText}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className={styles.helpers}>
              <button
                type="button"
                className="btn btn--sm"
                disabled={pasting || pasteCounts.usable === 0}
                onClick={() => void applyPaste()}
              >
                {pasting
                  ? "Adding…"
                  : `Add ${formatCount(pasteCounts.usable)} ${
                      pasteCounts.usable === 1 ? "holding" : "holdings"
                    }`}
              </button>
              {pasteCounts.refused > 0 ? (
                <span className="small muted">
                  {formatCount(pasteCounts.refused)} cannot be added
                </span>
              ) : null}
            </div>
          </div>
        </details>

        {modeStatus ? (
          <p role="status" className="small muted">
            {modeStatus}
          </p>
        ) : null}

        {message ? (
          <div
            className={`notice ${message.tone === "warn" ? "notice--alert" : "notice--quiet"}`}
            role="status"
          >
            <div>
              <p>
                <strong>{message.title}</strong>
              </p>
              {message.body ? <p className="small muted">{message.body}</p> : null}
              {message.undo ? (
                <button type="button" className="btn btn--sm" onClick={message.undo}>
                  Undo
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className={styles.meterBlock}>
          {mode === "bp" ? (
            <div className="meter">
              <span className="meter__track">
                {/* The bar is the state: royal blue once the portfolio accounts for
                 * exactly 100% of itself, red while it is short of or over it. */}
                <span
                  className={whole ? "meter__fill meter__fill--whole" : "meter__fill"}
                  style={{ width: `${Math.min(100, portfolio.total / 100)}%` }}
                />
              </span>
              <span className="meter__label">
                <span>Total</span>
                <span className="meter__figure">
                  <span className="meter__value">{formatWeightBp(portfolio.total)}</span>
                  <span className="meter__of">of 100.00%</span>
                </span>
              </span>
            </div>
          ) : null}
          <p className="small muted">
            {mode === "bp" ? (
              <span
                className={`num tally__gate ${
                  tally.ok ? "tally__gate--open" : "tally__gate--locked"
                }`}
              >
                {portfolio.unallocatedBp > 0 ? (
                  // The figures are `formatWeightBp`'s, the words of `tallyOf`'s, and the
                  // only thing added here is the glossary popover on the word itself: the
                  // sentence leads the line now, so `Term` has a word of its own to sit on.
                  <>
                    {formatWeightBp(portfolio.unallocatedBp)}{" "}
                    <Term name="unallocated-weight">unallocated</Term>
                  </>
                ) : (
                  lineStart(tally.sentence)
                )}
              </span>
            ) : (
              <>
                <span className="num">{formatCents(portfolio.total)}</span> total
              </>
            )}
          </p>
          {entries.length > 0 && mode === "bp" ? (
            <div className={styles.helpers}>
              {portfolio.unallocatedBp > 0 ? (
                <button type="button" className="btn btn--sm" onClick={fillWithCash}>
                  Fill the rest with cash
                </button>
              ) : null}
              {portfolio.unallocatedBp > 0 || portfolio.overBp > 0 ? (
                <button
                  type="button"
                  className="btn btn--sm btn--quiet"
                  onClick={scaleToHundred}
                >
                  Scale to 100%
                </button>
              ) : null}
              {/* Always here in percent mode, not only when the total is off: the way
                  back to equal weights has to exist after a hand edit too. */}
              <button
                type="button"
                className="btn btn--sm btn--quiet"
                onClick={equalWeights}
              >
                Equal weight
              </button>
            </div>
          ) : null}
        </div>

        {entries.length > 0 ? (
          <HoldingRows
            model={model}
            mode={mode}
            entries={entries}
            reorder={reorder}
            onAmount={(entry, amount) => {
              setModeStatus(null);
              portfolio.setAmount(entry.kind, entry.key, amount);
            }}
            onRemove={(kind, key) => {
              portfolio.remove(kind, key);
              setMessage(null);
              setModeStatus(null);
            }}
            onRemoveAll={removeAll}
          />
        ) : null}
      </div>
    </section>
  );
}

/**
 * The phone's holdings bar: the same rows, as chips, with the toggle that opens the
 * pane.
 *
 * It reads the model rather than holding its own list — a chip that disagreed with a row
 * would be a second source of truth, and the point of the bar is that the visitor can
 * see the portfolio without the pane taking the screen.
 */
/**
 * The holdings pane, shrunk to what a reader needs while reading a lens: the ticker and
 * its weight, and one button back to the fields.
 *
 * It is the same data as the pane — `model.portfolio.entries`, in the visitor's order —
 * so collapsing cannot change a number. The chip bar above it is the phone's version of
 * the same idea; this one is the wide layout's, where the pane is a column rather than a
 * disclosure.
 */
export function HoldingsCompact({
  model,
  onExpand,
}: {
  model: WorkspaceModel;
  onExpand: () => void;
}) {
  const { entries, mode } = model.portfolio;
  return (
    <section className="panel" aria-labelledby="holdings-compact-heading">
      <div className="panel__head">
        <h2 id="holdings-compact-heading" className="panel__title">
          Your holdings
        </h2>
        <button
          type="button"
          className={`btn btn--sm ${styles.collapseControl}`}
          aria-expanded={false}
          aria-controls="holdings-pane-region"
          onClick={onExpand}
        >
          Edit
        </button>
      </div>
      <div className="panel__body">
        <ul className={styles.compactList}>
          {entries.map((entry) => (
            <li key={`${entry.kind}:${entry.key}`} className={styles.compactRow}>
              <span className="mono">{entryLabel(entry.kind, entry.key)}</span>
              <span className={styles.compactWeight}>
                {mode === "bp" ? formatWeightBp(entry.amount) : formatCents(entry.amount)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function HoldingsChips({
  model,
  open,
  onToggle,
}: {
  model: WorkspaceModel;
  open: boolean;
  onToggle: () => void;
}) {
  const { entries, mode } = model.portfolio;
  return (
    <div className={styles.chipBar}>
      <ul className={styles.chipList} aria-label="Holdings in this portfolio">
        {entries.map((entry) => (
          <li key={`${entry.kind}:${entry.key}`}>
            <span className="chip chip--mono">
              {entryLabel(entry.kind, entry.key)}{" "}
              {mode === "bp" ? formatWeightBp(entry.amount) : formatCents(entry.amount)}
            </span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="btn btn--sm"
        aria-expanded={open}
        aria-controls="holdings-pane-region"
        onClick={onToggle}
      >
        {open ? "Hide holdings" : "Edit holdings"}
      </button>
    </div>
  );
}
