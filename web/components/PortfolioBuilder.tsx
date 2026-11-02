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
 * must add up to 100, or **dollars** that are the total by definition. The mode is
 * part of the URL, so a shared link reproduces the numbers that were typed rather
 * than a re-normalised version of them.
 *
 * The app never suggests a fund it cannot load, and never claims a stock exists in a
 * release that does not list it.
 *
 * The list is shown in the order the visitor gave it — typed order, then whatever they
 * dragged it into. Nothing here sorts: the order is theirs, it is stored in the URL
 * with the amounts (`fragment.ts`), and a reorder is a normal edit of that link.
 */

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";

import { AmountInput } from "@/components/AmountInput";
import { Notice } from "@/components/Notice";
import { loadSecurities, publishesSecurities, resolveAlias } from "@/lib/data";
import { encodePortfolio } from "@/lib/fragment";
import { formatCents, formatFundList, formatWeightBp } from "@/lib/format";
import { POPULAR_ORDER } from "@/lib/popular";
import { accepts, isCarriable, normaliseSymbol, refusal } from "@/lib/securities";
import { USD_NOTIONAL_CENTS } from "@/lib/portfolio-weights";
import { usePortfolio } from "@/lib/use-portfolio";
import { useRelease, useTickers } from "@/lib/use-release";
import { useReorderList } from "@/lib/use-reorder";
import {
  CASH_KEY,
  FULL_ALLOCATION_BP,
  type EntryKind,
  type EntryMode,
  type PortfolioEntry,
} from "@/lib/types";

/** `VT` / `AMZN` / `Cash`: what a row is called, whatever kind it is. */
function entryLabel(entry: PortfolioEntry): string {
  return entry.kind === "cash" ? "Cash" : entry.key;
}

/** What the row's identity is called in a remove button, for a screen reader. */
function removeLabel(entry: PortfolioEntry): string {
  return entry.kind === "cash" ? "cash" : entry.key;
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
      return entry ? entryLabel(entry) : "";
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
  const unallocatedBp = FULL_ALLOCATION_BP - portfolio.total;

  /** Every add path clears the undo offers: they belong to the portfolio they changed. */
  function addEntry(kind: EntryKind, key: string) {
    setCleared(null);
    setConverted(null);
    portfolio.add(kind, key);
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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const typed = input.trim();
    if (typed.length === 0 || adding) return;

    if (typed.toLowerCase() === "cash" || typed.toLowerCase() === "cash position") {
      addEntry("cash", CASH_KEY);
      setInput("");
      setMessage({
        tone: "info",
        title: "Added cash",
        body: "Set the amount it represents. Cash is part of your money but has no company behind it.",
      });
      return;
    }

    const ticker = normaliseSymbol(typed);
    if (!isCarriable(ticker)) {
      setMessage({
        tone: "warn",
        title: `${typed} is not a ticker`,
        body: "Tickers are upper-case letters, digits, dots and dashes.",
      });
      return;
    }

    if (release.status === "loading") {
      setMessage({
        tone: "info",
        title: "Still reading the release",
        body: "One moment — the fund list has not loaded yet.",
      });
      return;
    }
    if (release.status === "error") {
      setMessage({
        tone: "warn",
        title: "The release could not be read",
        body: release.error.message,
      });
      return;
    }

    // 1. A fund this release publishes. The common case, and the cheapest test.
    if (catalog.includes(ticker)) {
      addFund(ticker);
      return;
    }

    setAdding(true);
    try {
      // 2. A share class of a published fund (`VFIAX` → `VOO`): one portfolio with
      //    many tickers, and the release publishes one page per portfolio.
      const published = await resolveAlias(release.data, ticker).catch(() => null);
      if (published && catalog.includes(published)) {
        addFund(
          published,
          `${ticker} is a share class of ${published}, so the holdings are the same.`,
        );
        return;
      }

      // 3. A stock the visitor holds directly. Identity comes from the release's own
      //    symbol object, not from the ticker: the status is the build's verdict on
      //    whether this symbol is one company's common stock.
      const rows = await loadSecurities(release.data, [ticker]).catch(() => null);
      const row = rows?.get(ticker);
      if (row) {
        const status = row[3];
        if (!accepts(status)) {
          setMessage({
            tone: "warn",
            title: `${ticker} cannot be added as a stock`,
            body: refusal(status) ?? "This release lists it, but not as a common stock.",
          });
          return;
        }
        // The confirmation step: a symbol is a label, and the reader should see the
        // company the release resolved it to before it enters their portfolio.
        setMessage({
          tone: "info",
          title: `Added ${ticker} — ${row[1]}`,
          body: `Held directly. ${row[2] ?? "Exchange not filed"} · company ${row[0]}. Its weight is yours, not a fund's.`,
        });
        addEntry("security", ticker);
        return;
      }

      // Nothing published for this symbol, and the release does not carry the
      // symbols object at all: it was built before stocks were published, so it has
      // not been asked the question. Saying "AMZN is not in release X" would be a
      // false claim about the symbol, and the visitor cannot act on it.
      if (!publishesSecurities(release.data)) {
        setMessage({
          tone: "warn",
          title: "This release does not list stock symbols yet",
          body: `Release ${release.data.as_of} was built before stocks were published, so it can answer for funds but not for a stock you hold directly.`,
        });
        return;
      }

      setMessage({
        tone: "warn",
        title: `${ticker} is not in release ${release.data.as_of}`,
        body:
          catalog.length > 0
            ? `It is not a fund or a listed stock in this release. Funds published: ${formatFundList(catalog)}.`
            : "This release publishes no funds.",
      });
    } finally {
      setAdding(false);
    }
  }

  /**
   * Set one row's amount, refusing to go past 100% in percentage mode.
   *
   * The fragment decoder refuses a portfolio above 100%, so writing one here would
   * hand the visitor a link that will not reopen — their own edit would break their
   * own portfolio. The field therefore stops at the room the other rows leave, and
   * the notice says why rather than letting the number look broken.
   */
  function setEntryAmount(entry: PortfolioEntry, amount: number) {
    if (mode === "bp") {
      const room = FULL_ALLOCATION_BP - (portfolio.total - entry.amount);
      if (amount > room) {
        portfolio.setAmount(entry.kind, entry.key, Math.max(0, room));
        setMessage({
          tone: "warn",
          title: "That would take the portfolio over 100%",
          body: `Percentages have to add up to exactly 100%, so ${entryLabel(entry)} stops at ${(Math.max(0, room) / 100).toFixed(2)}%. Lower another row first, or switch to dollars.`,
        });
        return;
      }
    }
    setMessage(null);
    portfolio.setAmount(entry.kind, entry.key, amount);
  }

  function addFund(ticker: string, body?: string) {
    addEntry("fund", ticker);
    setInput("");
    setMessage(
      body
        ? { tone: "info", title: `Added ${ticker}`, body }
        : { tone: "info", title: `Added ${ticker}` },
    );
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
                ? "Percentages must add up to 100%."
                : "Dollars are the total — no need to reach any figure."}
            </span>
          </div>

          <ul className="portfolio-list" ref={reorder.listRef}>
            {portfolio.entries.map((entry, index) => (
              <li
                key={`${entry.kind}-${entry.key}`}
                className={reorder.draggingIndex === index ? "is-dragging" : undefined}
              >
                <button
                  type="button"
                  className="drag-handle"
                  {...reorder.handleProps(index)}
                  disabled={portfolio.entries.length < 2}
                  aria-label={`Reorder ${removeLabel(entry)}`}
                  aria-describedby={
                    portfolio.entries.length > 1 ? "reorder-hint" : undefined
                  }
                  title="Drag to reorder"
                >
                  <span aria-hidden="true">⠿</span>
                </button>
                <span className="portfolio-list__name">
                  <span className="ticker">{entryLabel(entry)}</span>
                  {entry.kind === "security" ? (
                    <span className="row-note">held directly</span>
                  ) : null}
                </span>
                <AmountInput
                  label={`Amount for ${entryLabel(entry)}`}
                  mode={mode}
                  amount={entry.amount}
                  onChange={(amount) => setEntryAmount(entry, amount)}
                />
                <button
                  type="button"
                  className="quiet"
                  onClick={() => portfolio.remove(entry.kind, entry.key)}
                  aria-label={`Remove ${removeLabel(entry)}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>

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
                ? portfolio.complete
                  ? "fully allocated"
                  : `${(unallocatedBp / 100).toFixed(2)}% unallocated`
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
            <Link href={shareHref} className="tally__go">
              View the ledger
            </Link>
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
