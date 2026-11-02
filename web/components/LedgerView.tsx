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

import { BENCHMARK_TICKER, benchmarkFor, benchmarkFromRollup } from "@/lib/benchmark";
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
  formatIsoDate,
} from "@/lib/format";
import { FULL_ALLOCATION_BP } from "@/lib/types";
import { useLedger } from "@/lib/use-ledger";
import { usePortfolio } from "@/lib/use-portfolio";
import { useBenchmark, useFunds, useRelease } from "@/lib/use-release";
import type { LedgerRow } from "@/lib/types";

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
    () => portfolio.entries.map((entry) => entry.ticker),
    [portfolio.entries],
  );
  const releaseData = release.status === "ready" ? release.data : null;
  const { funds, pending, error } = useFunds(releaseData, tickers);

  // The benchmark (ADR-0015) is read from one of three places, in order of what the
  // page already has: the fund document in memory (the portfolio holds it), the
  // compact rollup the release pre-rolled for it (~43 kB, the normal path), or —
  // for a release that predates the compact object — the benchmark's full fund
  // document (~1.58 MB), which every release has published since 2026-10-30. All
  // three are hash-checked against the release, and all three produce the same
  // payload, so the table cannot tell which one answered.
  const holdsBenchmark = portfolio.entries.some(
    (entry) => entry.ticker === BENCHMARK_TICKER,
  );
  const wantsBenchmark = !holdsBenchmark && portfolio.entries.length > 0;
  const compactEntry = releaseData?.objects.benchmarks?.files?.[BENCHMARK_TICKER];
  const wantsCompact = wantsBenchmark && compactEntry !== undefined;
  const wantsFundDocument = wantsBenchmark && compactEntry === undefined;
  const compactLoad = useBenchmark(releaseData, wantsCompact ? BENCHMARK_TICKER : null);
  const benchmarkLoad = useFunds(
    releaseData,
    wantsFundDocument ? [BENCHMARK_TICKER] : [],
  );
  const benchmark = useMemo(() => {
    const inMemory = funds.find((fund) => fund.ticker === BENCHMARK_TICKER);
    if (inMemory) return benchmarkFor(inMemory);
    if (compactLoad.data) return benchmarkFromRollup(compactLoad.data);
    const document = benchmarkLoad.funds[0];
    return document ? benchmarkFor(document) : null;
  }, [funds, compactLoad.data, benchmarkLoad.funds]);

  const weightsBp = useMemo(
    () =>
      Object.fromEntries(
        portfolio.entries.map((entry) => [entry.ticker, entry.weight_bp]),
      ),
    [portfolio.entries],
  );
  const {
    ledger,
    error: aggregateError,
    mode,
    durationMs,
  } = useLedger(funds, weightsBp, benchmark);
  // Named, so the loading state is a statement about which filings are still
  // arriving rather than a spinner. The comparison column is part of the table's
  // shape, so the table waits for it rather than reflowing under a reader.
  // `pending` only ever lists tickers that have not loaded, so a *failed* load would
  // stay in it forever and hold the ledger in "Loading" — which would make the
  // column-less fallback below unreachable. A benchmark that errored is answered by
  // the notice, not waited for. The compact object has the same rule, one status
  // earlier: it is waited for while loading, and not after it fails.
  const compactPending = wantsCompact && compactLoad.status === "loading";
  const pendingNames = [
    ...pending,
    ...(compactPending ? [BENCHMARK_TICKER] : []),
    ...(wantsFundDocument && !benchmarkLoad.error ? benchmarkLoad.pending : []),
  ];

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

  if (!ledger || pendingNames.length > 0) {
    return (
      <>
        <h1>Your look-through</h1>
        <p className="muted" role="status">
          Loading {pendingNames.length > 0 ? pendingNames.join(", ") : "the release"}…
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

  return (
    <>
      <h1>Your look-through</h1>
      <p className="muted">
        {formatCount(ledger.rows.length)} companies across {ledger.funds.length}{" "}
        {ledger.funds.length === 1 ? "fund" : "funds"}. Every weight is a share of the
        whole portfolio, so the column adds up to the covered part of your holdings, not
        to 100%.
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
      {ledger.benchmark ? (
        <p className="muted">
          The <strong>{ledger.benchmark.ticker}</strong> column is each company&apos;s
          share of {ledger.benchmark.ticker} — {ledger.benchmark.name}, filing period{" "}
          {formatIsoDate(ledger.benchmark.as_of)} — not a share of your portfolio. It is
          read from{" "}
          <a href={ledger.benchmark.source_url} rel="noopener noreferrer" target="_blank">
            {ledger.benchmark.ticker}&apos;s own SEC N-PORT filing
            <span className="sr-only"> for {ledger.benchmark.ticker}</span>
          </a>
          , which traces {formatCoveragePct(ledger.benchmark.coverage_pct)} of its gross
          weight to companies (filed weights slightly exceed 100% of net assets, so the
          column sums to a little more than that). A 0.00% here means the company is
          either absent from those traced holdings or filed at under 0.01% of{" "}
          {ledger.benchmark.ticker}&apos;s NAV — the smallest weight this column can show.
          Neither is the same as the fund not owning it.
        </p>
      ) : (
        <Notice tone="info" title="No benchmark comparison on this page">
          <p>
            {BENCHMARK_TICKER} could not be read from this release, so the comparison
            column is absent rather than filled with zeros — a zero would claim the
            benchmark holds none of these companies. Everything above and below is the
            portfolio&apos;s own arithmetic and is unaffected.
          </p>
        </Notice>
      )}
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
        benchmark={ledger.benchmark}
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
          derivative lines, which have no company by definition.
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
        do not sum to 100% are filed that way rather than corrected.
      </p>
    </>
  );
}
