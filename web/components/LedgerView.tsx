"use client";

/**
 * `/x`: the look-through ledger for the portfolio in the URL fragment.
 *
 * The page does not decide what is true about the data; it renders the four states
 * the frontend skill requires — loading, empty, error, ready — plus the one the data
 * adds: a portfolio that does not account for all of itself. In percentage mode that
 * is a total other than 100%, and it is refused rather than scaled, because silently
 * renormalising would answer a question the user did not ask. In dollar mode the
 * entries are the total, so the only incomplete portfolio is an empty one.
 *
 * Direct holdings join the ledger here, not in the aggregate: the portfolio knows
 * symbols, the release knows which company each symbol is, and `aggregate.ts` takes
 * resolved companies so it can stay a pure function of numbers (ADR-0014).
 */

import Link from "next/link";
import { useMemo, useState } from "react";

import { CompanyDrawer } from "@/components/CompanyDrawer";
import { FreshnessStrip, MetricsList } from "@/components/FreshnessStrip";
import { LedgerTable } from "@/components/LedgerTable";
import { Notice } from "@/components/Notice";
import {
  coverageBand,
  coverageChip,
  formatCount,
  formatDays,
  formatShare,
} from "@/lib/format";
import { splitPortfolio } from "@/lib/portfolio-weights";
import { refusal } from "@/lib/securities";
import { FULL_ALLOCATION_BP } from "@/lib/types";
import { useLedger } from "@/lib/use-ledger";
import { usePortfolio } from "@/lib/use-portfolio";
import { useFunds, useRelease } from "@/lib/use-release";
import { useSecurities } from "@/lib/use-securities";
import type { DirectHolding, LedgerRow } from "@/lib/types";

/**
 * How many companies the ledger renders before the visitor asks for the rest.
 *
 * A five-fund global portfolio resolves to about 4,500 companies, and rendering
 * all of them made the page several screens of scrolling before a reader saw
 * anything they had not already seen. The 100 largest by portfolio weight are
 * the answer to "what do I own?"; the tail is one click away rather than hidden.
 */
const LEDGER_PAGE = 100;

export function LedgerView() {
  const portfolio = usePortfolio();
  const [selected, setSelected] = useState<LedgerRow | null>(null);
  const [showAll, setShowAll] = useState(false);
  const release = useRelease();

  const tickers = useMemo(
    () =>
      portfolio.entries
        .filter((entry) => entry.kind === "fund")
        .map((entry) => entry.key),
    [portfolio.entries],
  );
  const symbols = useMemo(
    () =>
      portfolio.entries
        .filter((entry) => entry.kind === "security")
        .map((entry) => entry.key),
    [portfolio.entries],
  );

  const { funds, pending, error } = useFunds(
    release.status === "ready" ? release.data : null,
    tickers,
  );
  // Only the shards the portfolio's letters need are fetched, and a symbol that the
  // release does not carry comes back as missing rather than as an error.
  const securities = useSecurities(
    release.status === "ready" ? release.data : null,
    symbols,
  );

  const split = useMemo(
    () => splitPortfolio(portfolio.mode, portfolio.entries),
    [portfolio.mode, portfolio.entries],
  );

  const direct = useMemo<DirectHolding[]>(() => {
    const holdings: DirectHolding[] = [];
    for (const entry of split.direct) {
      const row = securities.rows.get(entry.key);
      // A symbol that is not in this release, or that is not a common stock, cannot
      // become a company. It is reported below rather than silently dropped.
      if (!row || row[3] !== "ok") continue;
      holdings.push({
        company_id: row[0],
        name: row[1],
        ticker: entry.key,
        weight: entry.weight,
      });
    }
    return holdings;
  }, [split.direct, securities.rows]);

  const {
    ledger,
    error: aggregateError,
    mode,
    durationMs,
  } = useLedger(funds, split.fundWeights, direct, split.cash);

  if (!portfolio.ready) {
    return (
      <>
        <h1>Your look-through</h1>
        <p className="muted">Reading your link…</p>
      </>
    );
  }

  if (portfolio.entries.length === 0) {
    return (
      <>
        <h1>Your look-through</h1>
        {portfolio.problem ? (
          <Notice tone="warn" title="That link could not be opened">
            {portfolio.problem}
          </Notice>
        ) : null}
        <Notice tone="info" title="Nothing in this portfolio yet">
          <p>
            Add a fund, a stock, or cash on the <Link href="/">builder</Link> and the
            ledger appears here. The portfolio is stored in this page&apos;s URL, so the
            link you copy is the portfolio you see.
          </p>
        </Notice>
      </>
    );
  }

  if (!portfolio.complete) {
    // Percentage mode only: dollar entries are their own total.
    const unallocated = FULL_ALLOCATION_BP - portfolio.total;
    return (
      <>
        <h1>Your look-through</h1>
        <Notice tone="warn" title="These percentages do not add up to 100%">
          <p>
            The portfolio totals {(portfolio.total / 100).toFixed(2)}%,{" "}
            {unallocated >= 0
              ? `${(unallocated / 100).toFixed(2)}% short of the full value of your holdings.`
              : `${(Math.abs(unallocated) / 100).toFixed(2)}% over.`}{" "}
            Look-through weights are a share of the whole portfolio, so they are only
            meaningful once the total is 100%. An unallocated remainder is shown as
            unallocated — it is not treated as cash.
          </p>
          <p>
            <button type="button" onClick={() => portfolio.equalise()}>
              Split equally
            </button>{" "}
            or <Link href="/">adjust the amounts</Link>.
          </p>
        </Notice>
      </>
    );
  }

  if (release.status === "error") {
    return (
      <>
        <h1>Your look-through</h1>
        <Notice tone="error" title={release.error.message} detail={release.error.detail}>
          <p>
            Nothing was read, so no number on this page is stale — there is simply nothing
            to show yet.
          </p>
        </Notice>
      </>
    );
  }

  if (error) {
    return (
      <>
        <h1>Your look-through</h1>
        <Notice tone="error" title={error.message} detail={error.detail}>
          <p>Remove and re-add the fund, or reload the page, to try again.</p>
        </Notice>
      </>
    );
  }

  if (aggregateError) {
    return (
      <>
        <h1>Your look-through</h1>
        <Notice tone="error" title="The aggregation failed" detail={aggregateError} />
      </>
    );
  }

  if (securities.error) {
    return (
      <>
        <h1>Your look-through</h1>
        <Notice
          tone="error"
          title="The stock symbols could not be read"
          detail={securities.error}
        >
          <p>
            Your portfolio is unchanged — this page only refuses to guess which company a
            symbol belongs to.
          </p>
        </Notice>
      </>
    );
  }

  const waitingSymbols = symbols.length > 0 && securities.pending;
  if (!ledger || waitingSymbols) {
    return (
      <>
        <h1>Your look-through</h1>
        <p className="muted" role="status">
          Loading{" "}
          {[...pending, ...(waitingSymbols ? symbols : [])].join(", ") || "the release"}…
        </p>
      </>
    );
  }

  // LedgerTable sorts the whole ledger and renders `limit` rows, so a sort answers
  // "which companies do most of my funds hold", not "of these 100".
  const visibleCount = showAll
    ? ledger.rows.length
    : Math.min(LEDGER_PAGE, ledger.rows.length);
  const suppressed = ledger.funds.filter(
    (fund) => coverageBand(fund.coverage_pct) === "none",
  );
  const partial = ledger.funds.filter(
    (fund) => coverageBand(fund.coverage_pct) === "partial",
  );
  const refused = symbols
    .map((symbol) => ({ symbol, row: securities.rows.get(symbol) }))
    .filter((entry) => !entry.row || entry.row[3] !== "ok");

  return (
    <>
      <h1>Your look-through</h1>
      <p className="muted">
        {formatCount(ledger.rows.length)} companies
        {ledger.funds.length > 0
          ? ` across ${ledger.funds.length} ${ledger.funds.length === 1 ? "fund" : "funds"}`
          : ""}
        {direct.length > 0
          ? `${ledger.funds.length > 0 ? " and" : " in"} ${direct.length} ${
              direct.length === 1 ? "company" : "companies"
            } you hold directly`
          : ""}
        . Every weight is a share of the whole portfolio, so the column adds up to the
        covered part of your holdings, not to 100%.
      </p>

      {release.status === "ready" ? (
        <FreshnessStrip release={release.data} ledger={ledger} />
      ) : null}

      {refused.length > 0 ? (
        <Notice
          tone="warn"
          title={`${refused.map((entry) => entry.symbol).join(", ")} could not be counted`}
        >
          <p>
            {refused.map((entry) => (
              <span key={entry.symbol} className="row-note" style={{ display: "block" }}>
                <strong>{entry.symbol}</strong>:{" "}
                {entry.row
                  ? (refusal(entry.row[3]) ??
                    "this release lists it, but not as a common stock.")
                  : "this release does not carry that symbol."}
              </span>
            ))}
          </p>
          <p>
            The rest of the portfolio is unaffected: the ledger below does not include the
            entries above, so its weights are shares of the portfolio you see.
          </p>
        </Notice>
      ) : null}

      {suppressed.length > 0 ? (
        <Notice
          tone="warn"
          title={`${suppressed.map((fund) => fund.ticker).join(", ")} ${suppressed.length === 1 ? "is" : "are"} not covered`}
        >
          <p>
            Coverage is below 60% of weight, so the concentration figures are not shown
            for this portfolio rather than computed over the part that resolved. Their
            share of the portfolio is shown, and the missing part is missing — not
            averaged away.
          </p>
        </Notice>
      ) : null}

      {partial.length > 0 ? (
        <Notice
          tone="info"
          title={`Partial coverage: ${partial.map((fund) => fund.ticker).join(", ")}`}
        >
          <p>
            Those funds resolved 60–70% of their weight to companies. The concentration
            figures below are computed over what resolved, so treat them as an
            approximation of the whole fund rather than a measurement of it.
          </p>
        </Notice>
      ) : null}

      <MetricsList ledger={ledger} />

      {ledger.metrics.cash_weight > 0 || ledger.metrics.unallocated_weight > 0 ? (
        <p className="muted">
          {ledger.metrics.cash_weight > 0 ? (
            <>
              Cash is {formatShare(ledger.metrics.cash_weight)} of your money. It has no
              company behind it, so it is left out of coverage — and counted in
              concentration, because it is still your money.
            </>
          ) : null}{" "}
          {ledger.metrics.unallocated_weight > 0 ? (
            <>
              {formatShare(ledger.metrics.unallocated_weight)} is unallocated: no entry
              accounts for it.
            </>
          ) : null}
        </p>
      ) : null}

      <h2 id="ledger-start">Companies</h2>
      <p className="sr-only" role="status">
        {showAll
          ? `All ${formatCount(ledger.rows.length)} companies shown`
          : `Showing ${formatCount(visibleCount)} of ${formatCount(ledger.rows.length)} companies`}
        . Aggregated in {mode === "worker" ? "a worker" : "the main thread"}
        {durationMs === null ? "" : ` in ${Math.round(durationMs)} milliseconds`}.
      </p>

      <LedgerTable
        rows={ledger.rows}
        limit={showAll ? undefined : LEDGER_PAGE}
        onSelect={setSelected}
      />

      {ledger.rows.length > LEDGER_PAGE ? (
        <p className="table-more">
          {showAll ? (
            <button type="button" onClick={() => setShowAll(false)}>
              Show the largest {LEDGER_PAGE} only
            </button>
          ) : (
            <button type="button" onClick={() => setShowAll(true)}>
              Show all {formatCount(ledger.rows.length)} companies
            </button>
          )}
        </p>
      ) : null}

      <details className="what-not-traced">
        <summary>What is not traced, and why</summary>
        <p>
          Coverage counts money, not rows. In this portfolio the positions with no company
          behind them are {formatCount(ledger.unmapped.positions_with_weight)} that carry
          any weight: {formatCount(ledger.unmapped.securities_with_weight)} share
          positions — mostly small non-US holdings filed through an identifier this
          release could not resolve — and{" "}
          {formatCount(ledger.unmapped.cash_and_derivatives_with_weight)} cash or
          derivative lines inside the funds, which have no company by definition.
        </p>
        <p className="muted">
          Another{" "}
          {formatCount(ledger.unmapped.positions - ledger.unmapped.positions_with_weight)}{" "}
          filed positions round to 0.00% of their fund. They are counted honestly but
          cannot move a weight, so they are not shown as companies. Nothing is
          redistributed across the companies that did resolve — that would make a
          partly-read fund look average.{" "}
          <Link href="/methodology/">How mapping works</Link>.
        </p>
      </details>

      <CompanyDrawer
        release={release.status === "ready" ? release.data : null}
        row={selected}
        onClose={() => setSelected(null)}
      />

      <details style={{ marginTop: "1.5rem" }}>
        <summary>Where each number comes from</summary>
        <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
          <table className="ledger">
            <caption>Each fund, its filing period, and its coverage.</caption>
            <thead>
              <tr>
                <th scope="col">Fund</th>
                <th scope="col">Filing period</th>
                <th scope="col" className="numeric">
                  Lag
                </th>
                <th scope="col" className="numeric">
                  Coverage
                </th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {ledger.funds.map((fund) => (
                <tr key={fund.ticker}>
                  <th scope="row">
                    {fund.ticker}
                    <span className="row-note">{fund.name}</span>
                  </th>
                  <td>
                    {fund.as_of}
                    <span className="row-note">filed {fund.filed_at}</span>
                  </td>
                  <td className="numeric">{formatDays(fund.lag_days)}</td>
                  <td className="numeric">
                    <span
                      className={
                        coverageBand(fund.coverage_pct) === "full"
                          ? "chip"
                          : "chip chip--warn"
                      }
                    >
                      {coverageChip(fund.coverage_pct)}
                    </span>
                  </td>
                  <td>
                    <a href={fund.source_url} rel="noopener noreferrer" target="_blank">
                      SEC N-PORT <span className="sr-only">filing for {fund.ticker}</span>
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <p className="muted" style={{ marginTop: "1.5rem", fontSize: "0.85rem" }}>
        Weights come from Form N-PORT, as filed. Funds report securities only, so
        positions outside the filing (cash, some derivatives) are absent, and weights that
        do not sum to 100% are filed that way rather than corrected. A stock you hold
        directly is counted once, at the weight you gave it.
      </p>
    </>
  );
}
