"use client";

/**
 * `/x`: the look-through ledger for the portfolio in the URL fragment.
 *
 * The page does not decide what is true about the data; it renders the four
 * states the frontend skill requires — loading, empty, error, ready — plus the
 * one the data adds: a portfolio whose weights do not total 100%. That last one
 * is refused rather than scaled, because silently renormalising would answer a
 * question the user did not ask.
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
  formatCoveragePct,
  formatDays,
} from "@/lib/format";
import { FULL_ALLOCATION_BP } from "@/lib/types";
import { useLedger } from "@/lib/use-ledger";
import { usePortfolio } from "@/lib/use-portfolio";
import { useFunds, useRelease } from "@/lib/use-release";
import type { LedgerRow } from "@/lib/types";

export function LedgerView() {
  const portfolio = usePortfolio();
  const [selected, setSelected] = useState<LedgerRow | null>(null);
  const release = useRelease();
  const tickers = useMemo(
    () => portfolio.entries.map((entry) => entry.ticker),
    [portfolio.entries],
  );
  const { funds, pending, error } = useFunds(
    release.status === "ready" ? release.data : null,
    tickers,
  );
  const weightsBp = useMemo(
    () =>
      Object.fromEntries(
        portfolio.entries.map((entry) => [entry.ticker, entry.weight_bp]),
      ),
    [portfolio.entries],
  );
  const { ledger, error: aggregateError, mode, durationMs } = useLedger(funds, weightsBp);

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
        <Notice tone="info" title="No funds in this portfolio yet">
          <p>
            Add a ticker on the <Link href="/">builder</Link> and the ledger appears here.
            The portfolio is stored in this page&apos;s URL, so the link you copy is the
            portfolio you see.
          </p>
        </Notice>
      </>
    );
  }

  if (!portfolio.balanced) {
    const unallocated = FULL_ALLOCATION_BP - portfolio.totalBp;
    return (
      <>
        <h1>Your look-through</h1>
        <Notice tone="warn" title="These weights do not add up to 100%">
          <p>
            The portfolio totals {(portfolio.totalBp / 100).toFixed(2)}%,{" "}
            {unallocated >= 0
              ? `${(unallocated / 100).toFixed(2)}% short of the full value of your holdings.`
              : `${(Math.abs(unallocated) / 100).toFixed(2)}% over.`}{" "}
            Look-through weights are a share of the whole portfolio, so they are only
            meaningful once the total is 100%.
          </p>
          <p>
            <button type="button" onClick={() => portfolio.equalise()}>
              Split equally
            </button>{" "}
            or <Link href="/">adjust the weights</Link>.
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

  if (!ledger) {
    return (
      <>
        <h1>Your look-through</h1>
        <p className="muted" role="status">
          Loading {pending.length > 0 ? pending.join(", ") : "the release"}…
        </p>
      </>
    );
  }

  const suppressed = ledger.funds.filter(
    (fund) => coverageBand(fund.coverage_pct) === "none",
  );
  const partial = ledger.funds.filter(
    (fund) => coverageBand(fund.coverage_pct) === "partial",
  );

  return (
    <>
      <h1>Your look-through</h1>
      <p className="muted">
        {formatCount(ledger.rows.length)} unique companies across {ledger.funds.length}{" "}
        {ledger.funds.length === 1 ? "fund" : "funds"} — a company held by more than one
        fund is counted once. Each weight is a share of the whole portfolio, so the column
        adds up to{" "}
        {ledger.metrics.covered_weight_pct >= 99.95 ? (
          "100% of your money."
        ) : (
          <>
            {formatCoveragePct(ledger.metrics.covered_weight_pct)} of your money — the
            part we could trace to companies, not 100%.
          </>
        )}
      </p>

      {release.status === "ready" ? (
        <FreshnessStrip release={release.data} ledger={ledger} />
      ) : null}

      {suppressed.length > 0 ? (
        <Notice
          tone="warn"
          title={`${suppressed.map((fund) => fund.ticker).join(", ")} ${suppressed.length === 1 ? "is" : "are"} not covered`}
        >
          <p>
            Coverage is below 60% of weight, so{" "}
            {suppressed.length === 1 ? "its holdings are" : "their holdings are"} left out
            of the totals below rather than redistributed across the companies that did
            resolve. Their share of the portfolio is shown, and the missing part is
            missing — not averaged away.
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

      <h2 id="ledger-start">Companies</h2>
      <p className="sr-only" role="status">
        {formatCount(ledger.rows.length)} unique companies loaded, sorted by portfolio
        weight. Aggregated in {mode === "worker" ? "a worker" : "the main thread"}
        {durationMs === null ? "" : ` in ${Math.round(durationMs)} milliseconds`}.
      </p>

      <LedgerTable rows={ledger.rows} onSelect={setSelected} />

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
        do not sum to 100% are filed that way rather than corrected.
      </p>
    </>
  );
}
