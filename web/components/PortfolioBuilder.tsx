"use client";

/**
 * The builder: one input, a list of funds, and the URL that is the portfolio.
 *
 * The list of tickers offered is the release's own `files[]` — the app never
 * suggests a fund it cannot load, and never claims a fund exists in a release
 * that does not list it.
 */

import Link from "next/link";
import { useMemo, useState } from "react";

import { Notice } from "@/components/Notice";
import { resolveAlias } from "@/lib/data";
import { encodePortfolio } from "@/lib/fragment";
import { usePortfolio } from "@/lib/use-portfolio";
import { formatFundList } from "@/lib/format";
import { POPULAR_ORDER } from "@/lib/popular";
import { useRelease, useTickers } from "@/lib/use-release";
import { WeightInput } from "@/components/WeightInput";
import { FULL_ALLOCATION_BP } from "@/lib/types";

function formatPercent(weightBp: number): string {
  return (weightBp / 100).toFixed(2);
}

/**
 * A percentage field that keeps what the user typed.
 *
 * Deriving the input's value from the basis points on every keystroke makes
 * `12.` collapse to `12` and moves the caret; the draft is the source of truth
 * while focused and is committed only when it parses.
 */
export function PortfolioBuilder() {
  const release = useRelease();
  const tickers = useTickers(release.status === "ready" ? release.data : null);
  const portfolio = usePortfolio();
  const [input, setInput] = useState("");
  // A submit that has to wait for the alias map must not let a second Enter press
  // add the same fund twice; the button is disabled while it is in flight.
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<{
    tone: "warn" | "info";
    title: string;
    body?: string;
  } | null>(null);

  const catalog = tickers.status === "ready" ? tickers.data : [];
  const unallocated = FULL_ALLOCATION_BP - portfolio.totalBp;

  // The release publishes 8,983 funds, so a list of them is useless as a starting
  // point: the first screen would be AAAA. These are the widely held ones, in the
  // operator's curated order, filtered to what this release can actually load.
  const chips = useMemo(
    () => POPULAR_ORDER.filter((ticker) => catalog.includes(ticker)).slice(0, 12),
    [catalog],
  );

  const shareHref = useMemo(() => {
    if (portfolio.entries.length === 0) return "/x/";
    return `/x/#${encodePortfolio({ entries: portfolio.entries })}`;
  }, [portfolio.entries]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const ticker = input.trim().toUpperCase();
    if (ticker.length === 0 || adding) return;

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
        title: "The fund list could not be read",
        body: release.error.message,
      });
      return;
    }
    if (portfolio.entries.some((entry) => entry.ticker === ticker)) {
      setMessage({ tone: "info", title: `${ticker} is already in your portfolio` });
      return;
    }
    if (!catalog.includes(ticker)) {
      // A fund is one portfolio with many share classes; the release publishes one
      // page per portfolio. Resolving the class here is the difference between
      // "VFIAX is not in this release" and opening the fund the visitor owns.
      setAdding(true);
      const published = await resolveAlias(release.data, ticker).catch(() => null);
      setAdding(false);
      if (published && catalog.includes(published)) {
        if (portfolio.entries.some((entry) => entry.ticker === published)) {
          setMessage({
            tone: "info",
            title: `${published} is already in your portfolio`,
            body: `${ticker} is a share class of ${published}.`,
          });
          setInput("");
          return;
        }
        portfolio.add(published);
        setInput("");
        setMessage({
          tone: "info",
          title: `Added ${published}`,
          body: `${ticker} is a share class of ${published}, so the holdings are the same.`,
        });
        return;
      }
      setMessage({
        tone: "warn",
        title: `${ticker} is not in release ${release.data.as_of}`,
        body:
          catalog.length > 0
            ? `This release publishes ${formatFundList(catalog)}.`
            : "This release publishes no funds.",
      });
      return;
    }

    portfolio.add(ticker);
    setInput("");
    setMessage(null);
  }

  return (
    <>
      <h1>See the companies behind your funds</h1>
      <p className="prose">
        Enter the tickers you hold. UnpackFund reads each fund&apos;s most recent SEC
        N-PORT filing, maps every holding to one company, and shows what you own once
        share classes are added up.
      </p>

      {portfolio.problem ? (
        <Notice tone="warn" title="That link could not be opened">
          {portfolio.problem}
        </Notice>
      ) : null}

      <form onSubmit={submit} className="field" noValidate>
        <label htmlFor="ticker" className="sr-only">
          Fund ticker
        </label>
        <input
          id="ticker"
          type="text"
          name="ticker"
          placeholder={
            chips.length > 0
              ? `Ticker, e.g. ${chips[0]}`
              : catalog.length > 0
                ? `Ticker, e.g. ${catalog[0]}`
                : "Ticker"
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
      </form>
      <p
        id="ticker-hint"
        className="muted"
        style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}
      >
        {release.status === "ready"
          ? catalog.length > 40
            ? // 8,531 tickers do not belong in a hint line; the count is the useful
              // fact, and typing a ticker is the interaction the field is for.
              `Release ${release.data.as_of} publishes ${catalog.length.toLocaleString("en-US")} funds. Type any of their tickers.`
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
                  onClick={() => portfolio.add(ticker)}
                  disabled={portfolio.entries.some((entry) => entry.ticker === ticker)}
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

      {portfolio.entries.length > 0 ? (
        <>
          <h2>Your portfolio</h2>
          <ul className="portfolio-list">
            {portfolio.entries.map((entry) => (
              <li key={entry.ticker}>
                <span className="ticker">{entry.ticker}</span>
                <WeightInput
                  ticker={entry.ticker}
                  weightBp={entry.weight_bp}
                  onChange={(bp) => portfolio.setWeightBp(entry.ticker, bp)}
                />
                <button
                  type="button"
                  className="quiet"
                  onClick={() => portfolio.remove(entry.ticker)}
                  aria-label={`Remove ${entry.ticker}`}
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
                {(portfolio.totalBp / 100).toFixed(2)}%
              </span>
            </span>
            <span className="muted">
              {portfolio.balanced
                ? "fully allocated"
                : `${(unallocated / 100).toFixed(2)}% unallocated`}
            </span>
            <button type="button" className="quiet" onClick={() => portfolio.equalise()}>
              Split equally
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
