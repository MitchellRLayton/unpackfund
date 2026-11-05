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
 *
 * The page's order is the answer first and the method underneath it (operator's
 * instruction, 2026-11-02): `<h1>`, one line of count, the freshness strip, the
 * concentration figures, the notices that report the state of *this* portfolio, the
 * Companies heading and the ledger — and, only below the table, one "How to read this
 * page" disclosure holding the explanations that used to open the page. The complaint
 * was about order rather than content ("too much information at the top of the page
 * discussing methodologies … all I really want are the metadata information you give in
 * tables"), so nothing was deleted to get here: the benchmark column's four facts, what
 * is not traced, the per-fund source table and the N-PORT note all still ship, after the
 * numbers they explain. `LedgerView.test.tsx` pins the shape — one paragraph of prose
 * above the table and this block as the first disclosure below it — so a later edit
 * cannot drift the prose back up or quiet-delete a paragraph while tidying.
 */

import Link from "next/link";
import { Fragment, useMemo, useState } from "react";

import { BENCHMARK_TICKER, benchmarkFor, benchmarkFromRollup } from "@/lib/benchmark";
import { CompanyDrawer } from "@/components/CompanyDrawer";
import { FreshnessStrip, MetricsList } from "@/components/FreshnessStrip";
import { LedgerTable } from "@/components/LedgerTable";
import { Notice } from "@/components/Notice";
import {
  ATTRIBUTED_LABEL,
  IDENTIFIED_LABEL,
  coveragePair,
  coverageSleeve,
  sleeveLine,
  sleeveShowsIdentified,
} from "@/lib/coverage";
import {
  coverageBand,
  coverageChip,
  formatCount,
  formatCoveragePct,
  formatDays,
  formatIsoDate,
  formatShare,
} from "@/lib/format";
import { ledgerCsv, ledgerCsvName, saveCsv } from "@/lib/export";
import { splitPortfolio } from "@/lib/portfolio-weights";
import { refusal } from "@/lib/securities";
import { FULL_ALLOCATION_BP } from "@/lib/types";
import { useLedger } from "@/lib/use-ledger";
import { usePortfolio } from "@/lib/use-portfolio";
import { useBenchmark, useCountries, useFunds, useRelease } from "@/lib/use-release";
import { useSecurities } from "@/lib/use-securities";
import type { DirectHolding, Ledger, LedgerRow } from "@/lib/types";
/**
 * How many companies the ledger renders before the visitor asks for the rest.
 *
 * A five-fund global portfolio resolves to about 4,500 companies, and rendering
 * all of them made the page several screens of scrolling before a reader saw
 * anything they had not already seen. The 100 largest by portfolio weight are
 * the answer to "what do I own?"; the tail is one click away rather than hidden.
 */
const LEDGER_PAGE = 100;

/**
 * One fund's coverage cell: the two shares, and then the sleeve behind them.
 *
 * The per-fund table is the one place a reader can compare a fund's coverage with its
 * own asset classes in the same block of text, so it is where the sleeve belongs. Every
 * number here follows `lib/coverage.ts`'s dual-read rule: a release that carries no
 * identified figures renders the single chip and nothing else, exactly as before.
 * The identified share never borrows the band wording or the band colour — those
 * describe attribution (`lookthrough-math-and-qa` §5) — and the equity line keeps its
 * attributed figure visible rather than folded into a sum.
 */
function FundCoverage({ fund }: { fund: Ledger["funds"][number] }) {
  const pair = coveragePair(fund);
  return (
    <>
      <span
        className={
          coverageBand(fund.coverage_pct) === "full" ? "chip" : "chip chip--warn"
        }
      >
        {pair.identified === null
          ? coverageChip(fund.coverage_pct)
          : `${formatCoveragePct(pair.attributed)} ${ATTRIBUTED_LABEL}`}
      </span>
      {pair.identified === null ? null : (
        <span className="chip chip--identified">
          {formatCoveragePct(pair.identified)} {IDENTIFIED_LABEL}
        </span>
      )}
    </>
  );
}

/** The classes of one fund, as the sleeve line the row beneath its own prints. */
function FundSleeve({ fund }: { fund: Ledger["funds"][number] }) {
  const sleeve = coverageSleeve(fund).filter((row) => row.attributed !== null);
  if (!sleeveShowsIdentified(sleeve)) return null;
  return (
    <tr>
      <td colSpan={5} style={{ paddingTop: 0 }}>
        <span className="row-note">{sleeve.map(sleeveLine).join("; ")}</span>
      </td>
    </tr>
  );
}

export function LedgerView() {
  const portfolio = usePortfolio();
  const [selected, setSelected] = useState<LedgerRow | null>(null);
  const [showAll, setShowAll] = useState(false);
  const release = useRelease();
  // The CSV names the release it came from, so it needs the release's stamp rather
  // than whatever the page happens to be showing.
  const releaseAsOf = release.status === "ready" ? release.data.as_of : null;

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
  const releaseData = release.status === "ready" ? release.data : null;
  const { funds, pending, error } = useFunds(releaseData, tickers);
  // Only the shards the portfolio's letters need are fetched, and a symbol that the
  // release does not carry comes back as missing rather than as an error.
  const securities = useSecurities(releaseData, symbols);

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

  // The benchmark (ADR-0015) is read from one of three places, in order of what the
  // page already has: the fund document in memory (the portfolio holds it), the
  // compact rollup the release pre-rolled for it (~17 kB gzipped, the normal path),
  // or — for a release that predates the compact object — the benchmark's full fund
  // document (~193 kB gzipped), which every release has published since 2026-10-30.
  // All three are hash-checked against the release, and all three produce the same
  // payload, so the table cannot tell which one answered. Nothing is fetched for a
  // portfolio with no company rows to compare.
  const holdsBenchmark = portfolio.entries.some(
    (entry) => entry.kind === "fund" && entry.key === BENCHMARK_TICKER,
  );
  const hasHoldings = tickers.length > 0 || symbols.length > 0;
  const wantsBenchmark = !holdsBenchmark && hasHoldings;
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
  // Geography is a second, independent channel (`web/DESIGN.md`): a release may publish
  // a country map, a benchmark, both, or neither, and neither waits on the other. The map
  // is a lookup for the rows, never a computation, and it deliberately does not gate the
  // table — an additive tag that arrives late must not leave a visitor on "Loading" the
  // way a permanently-pending ticker once did.
  const countriesLoad = useCountries(releaseData);
  const {
    ledger,
    error: aggregateError,
    mode,
    durationMs,
  } = useLedger(
    funds,
    split.fundWeights,
    direct,
    split.cash,
    benchmark,
    countriesLoad.data?.companies ?? null,
  );
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
        <Notice tone="info" title="Nothing in this portfolio yet">
          <p>
            Add a fund, a stock, or cash in the <Link href="/">Portfolio</Link> and the
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
            meaningful once the total is 100%.
            {unallocated >= 0
              ? " An unallocated remainder is shown as unallocated — it is not treated as cash."
              : ""}
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
  if (!ledger || waitingSymbols || pendingNames.length > 0) {
    return (
      <>
        <h1>Your look-through</h1>
        <p className="muted" role="status">
          Loading{" "}
          {[
            ...pending,
            ...(waitingSymbols ? symbols : []),
            ...(compactPending ? [BENCHMARK_TICKER] : []),
            ...(wantsFundDocument && !benchmarkLoad.error ? benchmarkLoad.pending : []),
          ].join(", ") || "the release"}
          …{" "}
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

      {/* The metadata the operator asked for, with both halves together: the strip above
       * says where these numbers came from and how old they are, and these three figures
       * say how concentrated they are. The concentration list used to sit below the
       * notices, which put a paragraph of state between the two tables — the first screen
       * read as prose with tables in it, the reverse of what was wanted. */}
      <MetricsList ledger={ledger} />

      {/* The four notices that follow are *state*, not method, which is why they stay above
       * the table while every explanation moves: each reports something true about this
       * particular portfolio — a symbol that could not be counted, a fund below the
       * coverage floor, funds in the partial band, a benchmark that is missing — and a
       * reader who scrolled past would be reading the table without knowing which of its
       * weights are complete. Their bodies are tightened to the sentence that matters,
       * because the mechanism they used to re-explain now lives in "How to read this
       * page" below the table. */}
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
            The rest of the portfolio is unaffected: the table below does not include the
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
            Coverage is below 60% of weight, so no concentration figure is shown: one
            computed over the part that resolved would describe a different portfolio, and
            nothing is averaged across the gap.
          </p>
        </Notice>
      ) : null}

      {partial.length > 0 ? (
        <Notice
          tone="info"
          title={`Partial coverage: ${partial.map((fund) => fund.ticker).join(", ")}`}
        >
          <p>
            They resolved 60–70% of their weight, so the concentration figures cover what
            resolved — an approximation of the whole fund, not a measurement of it.
          </p>
        </Notice>
      ) : null}

      {/* A missing benchmark is state too, and it has to arrive before the table it
       * changes: without it the comparison column is simply absent, and the reason
       * belongs with the other caveats a reader needs before reading weights — not
       * halfway down, between the heading and the table. */}
      {ledger.benchmark ? null : (
        <Notice tone="info" title="No benchmark comparison on this page">
          <p>
            {BENCHMARK_TICKER} could not be read from this release, so the comparison
            column is absent rather than filled with zeros — a zero would claim the
            benchmark holds none of these companies. The portfolio&apos;s own figures are
            unaffected.
          </p>
        </Notice>
      )}

      <h2 id="ledger-start">Companies</h2>
      {releaseAsOf ? (
        <p className="table-more">
          <button
            type="button"
            onClick={() =>
              saveCsv(
                ledgerCsv(ledger, { as_of: releaseAsOf }),
                ledgerCsvName(new Date(), releaseAsOf),
              )
            }
          >
            Download {formatCount(ledger.rows.length)} companies as CSV
          </button>
          <span className="row-note">
            Every row carries the release it came from, so the file can be checked later.
          </span>
        </p>
      ) : null}
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

      {/* The method, below the numbers it explains (operator's instruction, 2026-11-02).
       *
       * Everything from here to the closing details used to sit above the table, and it
       * made the page open with methodology instead of with an answer. It is moved and
       * tightened, never deleted: the benchmark column's four facts (what the column is,
       * what 0.00% does and does not mean, which way round the bracket subtracts, and
       * that it is computed unrounded and rounded once), the cash sentence, what is not
       * traced, the per-fund source table and the N-PORT note all still ship — after the
       * reader has the table, one click from it.
       *
       * Closed by default and opened by nothing: a reader who wants the method can ask for
       * it, and a reader who came for the numbers never scrolls through it first. It is
       * also the page's only top-level <details>, which is what `LedgerView.test.tsx`
       * relies on when it holds the explanation to the block *after* the table rather than
       * to a paragraph above it. The nested disclosures keep the old outline: the coverage
       * gap and the per-fund table still hide behind their own summaries, one level in. */}
      <details className="how-to-read">
        <summary>How to read this page</summary>

        {/* The benchmark column, carrying the same facts it had above the table with one
         * repetition removed — a reader who asks what "In VT" is gets the whole answer at
         * once, instead of meeting a wall of sentences between the heading and the column
         * it explains. The short version stays where it is needed: the table's own caption
         * names the benchmark, the direction of the bracket and the sign ink, because a
         * caption is read with the table (`static-xray-frontend` §4a). The provenance link
         * moves here, and `FreshnessStrip` still carries the portfolio's own provenance
         * above the fold — DESIGN rule 1 is about the visitor's own numbers, not about a
         * comparison column's method. */}
        {ledger.benchmark ? (
          <p className="muted">
            The <strong>{ledger.benchmark.ticker}</strong> column is each company&apos;s
            share of {ledger.benchmark.ticker} — {ledger.benchmark.name}, filing period{" "}
            {formatIsoDate(ledger.benchmark.as_of)} — read from{" "}
            <a
              href={ledger.benchmark.source_url}
              rel="noopener noreferrer"
              target="_blank"
            >
              {ledger.benchmark.ticker}&apos;s own SEC N-PORT filing
              <span className="sr-only"> for {ledger.benchmark.ticker}</span>
            </a>
            , which traces {formatCoveragePct(ledger.benchmark.coverage_pct)} of its gross
            weight to companies (filed weights slightly exceed 100% of net assets, so the
            column sums to a little more than that). A 0.00% here means the company is
            either absent from those traced holdings or filed at under 0.01% of{" "}
            {ledger.benchmark.ticker}&apos;s NAV — the smallest weight this column can
            show. Neither is the same as the fund not owning it. The figure in brackets is
            your weight minus {ledger.benchmark.ticker}&apos;s, in percentage points:
            negative means you hold less of the company than {ledger.benchmark.ticker}{" "}
            does, positive more. The two are shares of different wholes — yours of your
            portfolio, {ledger.benchmark.ticker}&apos;s of its own NAV — so the bracket
            compares two holdings; it is not a share of your portfolio. It is computed
            from the unrounded weights and rounded once, so subtracting the two printed
            numbers can be 0.01 away at a rounding boundary.
          </p>
        ) : null}

        {/* Cash and an unallocated remainder used to get a paragraph above the table, and
         * the paragraph stays because it carries a fact the strip does not: what cash does
         * to the arithmetic. The strip already states both amounts as cells, so nothing
         * numeric is lost by moving this down — cash is outside coverage because it has no
         * company behind it, and inside concentration because it is still your money. */}
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

        <details className="what-not-traced">
          <summary>What is not traced, and why</summary>
          <p>
            Coverage counts money, not rows. In this portfolio the positions with no
            company behind them are {formatCount(ledger.unmapped.positions_with_weight)}{" "}
            that carry any weight: {formatCount(ledger.unmapped.securities_with_weight)}{" "}
            share positions — mostly small non-US holdings filed through an identifier
            this release could not resolve — and{" "}
            {formatCount(ledger.unmapped.cash_and_derivatives_with_weight)} cash or
            derivative lines inside the funds, which have no company by definition.
          </p>
          <p className="muted">
            Another{" "}
            {formatCount(
              ledger.unmapped.positions - ledger.unmapped.positions_with_weight,
            )}{" "}
            filed positions round to 0.00% of their fund. They are counted honestly but
            cannot move a weight, so they are not shown as companies. Nothing is
            redistributed across the companies that did resolve — that would make a
            partly-read fund look average.{" "}
            <Link href="/methodology/">How mapping works</Link>.
          </p>
        </details>

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
                  <Fragment key={fund.ticker}>
                    <tr>
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
                        <FundCoverage fund={fund} />
                      </td>
                      <td>
                        <a
                          href={fund.source_url}
                          rel="noopener noreferrer"
                          target="_blank"
                        >
                          SEC N-PORT{" "}
                          <span className="sr-only">filing for {fund.ticker}</span>
                        </a>
                      </td>
                    </tr>
                    <FundSleeve fund={fund} />
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {/*
            The sentence that keeps the two shares apart. It ships only when the release
            measures identification at all — a release without `identified_pct` renders
            the table it rendered before, with no new prose to explain a number that is
            not on the page.
          */}
          {ledger.funds.some((fund) => coveragePair(fund).identified !== null) ? (
            <p className="muted" style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
              Two shares, two questions: a position is <em>identified</em> when we know
              which security it is, and <em>attributed</em> when we know which company or
              entity it belongs to. Attribution is the stricter test and the one the
              coverage bands measure, so the identified share is always the larger number
              and is not a measure of company coverage.
            </p>
          ) : null}
        </details>

        <p className="muted" style={{ marginTop: "1.5rem", fontSize: "0.85rem" }}>
          Weights come from Form N-PORT, as filed. Funds report securities only, so
          positions outside the filing (cash, some derivatives) are absent, and weights
          that do not sum to 100% are filed that way rather than corrected. A stock you
          hold directly is counted once, at the weight you gave it.
        </p>
      </details>

      <CompanyDrawer
        release={release.status === "ready" ? release.data : null}
        row={selected}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
