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
import { encodePortfolio } from "@/lib/fragment";
import { usePortfolio } from "@/lib/use-portfolio";
import { useRelease } from "@/lib/use-release";
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
function WeightInput({
  ticker,
  weightBp,
  onChange,
}: {
  ticker: string;
  weightBp: number;
  onChange: (weightBp: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? formatPercent(weightBp);

  return (
    <span className="weight-input">
      <input
        type="text"
        inputMode="decimal"
        aria-label={`Portfolio weight for ${ticker}, in percent`}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const parsed = Number.parseFloat(next.replace(/[^0-9.]/g, ""));
          if (Number.isFinite(parsed)) onChange(Math.round(parsed * 100));
        }}
        onBlur={() => setDraft(null)}
      />
      <span aria-hidden="true">%</span>
    </span>
  );
}

export function PortfolioBuilder() {
  const release = useRelease();
  const portfolio = usePortfolio();
  const [input, setInput] = useState("");
  const [message, setMessage] = useState<{
    tone: "warn" | "info";
    title: string;
    body?: string;
  } | null>(null);

  const catalog = release.status === "ready" ? release.data.tickers : [];
  const unallocated = FULL_ALLOCATION_BP - portfolio.totalBp;

  const shareHref = useMemo(() => {
    if (portfolio.entries.length === 0) return "/x/";
    return `/x/#${encodePortfolio({ entries: portfolio.entries })}`;
  }, [portfolio.entries]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const ticker = input.trim().toUpperCase();
    if (ticker.length === 0) return;

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
      setMessage({
        tone: "warn",
        title: `${ticker} is not in release ${release.data.manifest.as_of}`,
        body:
          catalog.length > 0
            ? `This release publishes ${catalog.join(", ")}.`
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
          placeholder={catalog.length > 0 ? `Ticker, e.g. ${catalog[0]}` : "Ticker"}
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
        <button type="submit" className="primary">
          Add
        </button>
      </form>
      <p
        id="ticker-hint"
        className="muted"
        style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}
      >
        {release.status === "ready"
          ? `Release ${release.data.manifest.as_of} publishes ${catalog.length} ${catalog.length === 1 ? "fund" : "funds"}: ${catalog.join(", ")}.`
          : release.status === "loading"
            ? "Reading the release pointer…"
            : "The release pointer could not be read."}
      </p>

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
