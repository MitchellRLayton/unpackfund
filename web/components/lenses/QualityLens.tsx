"use client";

/**
 * Data quality: what the numbers above cannot tell you, and why.
 *
 * This lens is where the product keeps its word. Coverage is shown by weight, in
 * the two bands the whole site uses (70% full, 60% partial, below that withheld),
 * with the percentage printed in every band including the withheld one. The weight
 * that resolved to no company is split by cause — a share position nothing
 * identified is a mapping failure, a cash or derivative line is not a failure at
 * all — and the parts reconcile against the whole portfolio in one table, so a
 * reader can check the arithmetic instead of trusting the prose.
 *
 * Nothing here is softened. A number that is missing is shown as missing, a weight
 * that is not in a company is not redistributed over the ones that are, and the
 * three dates behind every figure are printed beside it rather than in a footnote.
 */

import { useMemo } from "react";

import { saveCsv } from "@/lib/export";
import {
  coverageBand,
  formatCount,
  formatCoveragePct,
  formatDays,
  formatShare,
} from "@/lib/format";
import type { LensProps } from "@/components/workspace/types";

import {
  CellNote,
  CoverageChip,
  LensAnswer,
  LensExport,
  LensLede,
  LensProblem,
  LensSection,
  LensState,
} from "./lens-chrome";
import { lensCsvName, qualityCsv, type QualityCsvFund } from "./lens-csv";
import { lensGateState } from "./lens-gate";
import { fundMixRows, untracedTotals, type FundMixRow } from "./lens-math";

/** The band order the table is sorted by: the least covered fund first. */
const BAND_RANK: Record<string, number> = { none: 0, partial: 1, full: 2 };

function coverageSortValue(row: FundMixRow): number {
  if (row.coveragePct === null) return Number.POSITIVE_INFINITY;
  return BAND_RANK[coverageBand(row.coveragePct)] ?? 3;
}

export function QualityLens({ model }: LensProps) {
  const gate = lensGateState(model);
  const ledger = model.ledger;
  const docs = model.fundByTicker;
  const fundWeights = model.split.fundWeights;
  const funds = model.funds;

  const analysis = useMemo(() => {
    if (!ledger) return null;
    const built = fundMixRows({
      tickers: Object.keys(fundWeights),
      weights: fundWeights,
      docs,
      top10: null,
    })
      // A fund with no weight in your portfolio moves no number here, and one with
      // no filing is impossible while the gate says ready; both are dropped rather
      // than printed as a row of zeroes.
      .filter((row) => row.weight > 0 && row.coveragePct !== null);

    const rows = built
      .slice()
      .sort(
        (left, right) =>
          coverageSortValue(left) - coverageSortValue(right) ||
          (left.coveragePct ?? 0) - (right.coveragePct ?? 0) ||
          right.weight - left.weight ||
          left.ticker.localeCompare(right.ticker),
      );

    const totals = untracedTotals({
      metrics: ledger.metrics,
      unmapped: ledger.unmapped,
      funds,
      weights: fundWeights,
    });

    const noCompanyTotal = totals.unmatchedSecurities + totals.unmatchedCashDerivatives;
    return { rows, totals, noCompanyTotal };
  }, [ledger, docs, fundWeights, funds]);

  if (gate.kind === "blocked") {
    return <LensState title={gate.title} body={gate.body} />;
  }

  if (!analysis) {
    return (
      <LensState
        title="Working out the look-through"
        body="The ledger is aggregating the funds' filings. This lens reads only the finished ledger, so it waits for it."
      />
    );
  }

  const { rows, totals, noCompanyTotal } = analysis;
  const releaseAsOf = model.releaseAsOf ?? "unknown";
  const metrics = gate.ledger.metrics;
  const unmapped = gate.ledger.unmapped;
  const covered = formatCoveragePct(metrics.covered_weight_pct);

  const partialFunds = rows.filter(
    (row) => row.coveragePct !== null && coverageBand(row.coveragePct) === "partial",
  );
  const withheldFunds = rows.filter(
    (row) => row.coveragePct !== null && coverageBand(row.coveragePct) === "none",
  );

  const exportQuality = () => {
    const csvFunds: QualityCsvFund[] = rows.flatMap((row) =>
      row.coveragePct === null ||
      row.asOf === null ||
      row.filedAt === null ||
      row.lagDays === null
        ? []
        : [
            {
              ticker: row.ticker,
              weight: row.weight,
              noCompany: row.unmatchedWeight ?? 0,
              coveragePct: row.coveragePct,
              asOf: row.asOf,
              filedAt: row.filedAt,
              lagDays: row.lagDays,
            },
          ],
    );
    saveCsv(
      qualityCsv({
        funds: csvFunds,
        invested: metrics.invested_weight,
        coveragePct: metrics.covered_weight_pct,
        totals,
        unmapped,
        releaseAsOf,
      }),
      lensCsvName("quality", new Date(), releaseAsOf),
    );
  };

  return (
    <div className="stack">
      <LensProblem model={model} />
      <LensAnswer>
        {covered} of the weight you invested resolved to a company; the rest is weight the
        release could not name.
      </LensAnswer>
      <LensLede>
        Coverage is the share of a fund&rsquo;s weight whose positions resolved to a
        company, and the bands are the same everywhere on this site: 70% and above is
        full, 60% up to but not including 70% is partial, below 60% is withheld. The
        second table splits everything that is not a company by cause, and the parts add
        up to your whole portfolio. No figure here is estimated, averaged over the gap, or
        rounded up to a band.
      </LensLede>

      <LensSection
        title="Coverage by weight"
        action={<LensExport label="coverage and filing dates" onExport={exportQuality} />}
      >
        <div className="table-wrap">
          <table className="table">
            <caption>
              One row per fund that carries a weight in your portfolio, least covered
              first, so the fund a reader most needs to see is at the top. Weight is a
              share of your whole portfolio and the column adds up to the weight your
              funds carry. Weight with no company is the part of that fund&rsquo;s money
              in positions that resolved to no company — a security no identifier matched,
              a cash line, or a derivative — so it is the weight the fund contributes to
              the second table. Coverage is the share of the fund&rsquo;s own weight that
              did resolve; the bands are exactly 70% and above full, 60% to just under 70%
              partial, below 60% withheld. The last column is the three filing dates the
              row&rsquo;s numbers depend on: the end of the reporting period, the day the
              filing was filed, and how many days that took.
            </caption>
            <thead>
              <tr>
                <th scope="col">Fund</th>
                <th scope="col" className="num">
                  Weight
                </th>
                <th scope="col" className="num">
                  Weight with no company
                </th>
                <th scope="col" className="num">
                  Coverage
                </th>
                <th scope="col">Reporting period, filed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.ticker}>
                  <th scope="row">
                    <span className="mono">{row.ticker}</span>
                    {row.name ? <CellNote>{row.name}</CellNote> : null}
                  </th>
                  <td className="num">{formatShare(row.weight)}</td>
                  <td className="num">
                    {formatShare(row.unmatchedWeight ?? 0)}
                    <CellNote>
                      {formatCount(row.unmatchedPositions ?? 0)} of{" "}
                      {formatCount(row.positions ?? 0)} positions
                    </CellNote>
                  </td>
                  <td className="num">
                    {row.coveragePct === null ? (
                      "no filing"
                    ) : (
                      <CoverageChip pct={row.coveragePct} />
                    )}
                  </td>
                  <td>
                    {row.asOf && row.filedAt && row.lagDays !== null
                      ? `${row.asOf} · filed ${row.filedAt} · ${formatDays(row.lagDays)}`
                      : "no filing"}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Your portfolio, cash excluded</th>
                <td className="num">{formatShare(metrics.invested_weight)}</td>
                <td className="num">{formatShare(noCompanyTotal)}</td>
                <td className="num">
                  <CoverageChip pct={metrics.covered_weight_pct} />
                </td>
                <td>
                  {gate.ledger.oldest_as_of !== null ? (
                    <CellNote>
                      oldest reporting period {gate.ledger.oldest_as_of}
                      {gate.ledger.max_lag_days === null
                        ? ""
                        : `; slowest filing ${formatDays(gate.ledger.max_lag_days)}`}
                    </CellNote>
                  ) : (
                    <CellNote>no fund filings in this portfolio</CellNote>
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </LensSection>

      <LensSection title="Where the rest of your money is">
        <div className="table-wrap">
          <table className="table">
            <caption>
              Every share of your portfolio, so the parts can be checked against the whole
              instead of taken on trust. A share position with no company is a mapping
              failure and is disclosed as one; cash and derivative lines have no company
              by definition and are not failures. Count is company lines in the first row
              and positions in the next two, counting only positions that carry weight — a
              position that rounds to zero basis points is a line, never money. The last
              row is the difference between the weight the filings report and the weight
              the cash and positions account for, kept signed so the total closes.
            </caption>
            <thead>
              <tr>
                <th scope="col">What it is</th>
                <th scope="col" className="num">
                  Weight
                </th>
                <th scope="col" className="num">
                  Count
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Companies the release names</th>
                <td className="num">{formatShare(totals.resolved)}</td>
                <td className="num">{formatCount(gate.ledger.rows.length)}</td>
              </tr>
              <tr>
                <th scope="row">Share positions with no company</th>
                <td className="num">{formatShare(totals.unmatchedSecurities)}</td>
                <td className="num">{formatCount(unmapped.securities_with_weight)}</td>
              </tr>
              <tr>
                <th scope="row">Cash and derivative lines inside funds</th>
                <td className="num">{formatShare(totals.unmatchedCashDerivatives)}</td>
                <td className="num">
                  {formatCount(unmapped.cash_and_derivatives_with_weight)}
                </td>
              </tr>
              <tr>
                <th scope="row">Cash you hold</th>
                <td className="num">{formatShare(totals.cash)}</td>
                <td className="num">—</td>
              </tr>
              {totals.unallocated > 0 ? (
                <tr>
                  <th scope="row">Not entered</th>
                  <td className="num">{formatShare(totals.unallocated)}</td>
                  <td className="num">—</td>
                </tr>
              ) : null}
              <tr>
                <th scope="row">
                  Filed weight outside the holding schedules
                  <CellNote>a signed correction, usually negative</CellNote>
                </th>
                <td className="num">{formatShare(totals.filedOvershoot)}</td>
                <td className="num">—</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Everything</th>
                <td className="num">{formatShare(totals.total)}</td>
                <td className="num" />
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="tiny muted">
          {unmapped.positions === unmapped.positions_with_weight
            ? `All ${formatCount(unmapped.positions)} filed positions with no company carry weight and are counted as money in the rows above.`
            : `${formatCount(unmapped.positions)} filed positions have no company behind them; ${formatCount(
                unmapped.positions_with_weight,
              )} of them carry weight and are counted as money in the rows above. The other ${formatCount(
                unmapped.positions - unmapped.positions_with_weight,
              )} round to zero basis points, so they are counted as lines and never described as weight.`}
        </p>
      </LensSection>

      <LensSection title="What is not traced">
        {/* `.prose` for the measure and the rhythm: this is a column of reading, not
            a caption, and 68ch is the width the site reads at. */}
        <div className="prose">
          <p>
            {covered} of the weight you invested resolved to a company.{" "}
            {formatShare(totals.resolved)} of your whole portfolio is in a company the
            release names; {formatShare(1 - totals.resolved)} is not in one, and the table
            above says what each part of that is.
          </p>
          <p>
            Nothing is redistributed. Weight that resolved to no company stays outside
            every company line and every concentration figure, so no company looks larger
            than its filings say and no coverage figure is raised by money that could not
            be placed.
          </p>
          {partialFunds.length > 0 ? (
            <p>
              In the partial band:{" "}
              {partialFunds
                .map(
                  (row) =>
                    `${row.ticker} (${formatCoveragePct(row.coveragePct ?? 0)} of its weight)`,
                )
                .join(", ")}
              . The figures drawn from a fund in this band come from that share of its
              filing, and the rest is disclosed as weight with no company rather than
              assumed.
            </p>
          ) : null}
          {withheldFunds.length > 0 ? (
            <p>
              Below the 60% floor:{" "}
              {withheldFunds
                .map(
                  (row) =>
                    `${row.ticker} (${formatCoveragePct(row.coveragePct ?? 0)} of its weight)`,
                )
                .join(", ")}
              . A fund in this band has no concentration figure shown anywhere on the
              site: withholding it is the only way a fund that traced a third of itself
              cannot be mistaken for an average one.
            </p>
          ) : null}
          {partialFunds.length === 0 && withheldFunds.length === 0 ? (
            <p>
              Every fund in your mix is in the full coverage band, 70% or more. That is
              still not all of it: a fund in the full band can leave up to 30% of its
              weight with no company, so each figure here is a floor rather than an exact
              value.
            </p>
          ) : null}
          {gate.ledger.oldest_as_of !== null && gate.ledger.max_lag_days !== null ? (
            <p>
              The filings are not simultaneous. The oldest reporting period in your mix
              ends {gate.ledger.oldest_as_of}, and the slowest filer took{" "}
              {formatDays(gate.ledger.max_lag_days)} to file. A company held by two funds
              can therefore be measured twice, at two dates, and the ledger treats the
              later weight as the same company rather than an error.
            </p>
          ) : null}
          <p>
            A position with a negative weight — a short inside a fund — is counted in the
            ledger and printed where it appears, but it is excluded from the ten largest
            companies and from every concentration figure, because a bar and a sum share
            can only be made of positive parts of a whole.
          </p>
        </div>
      </LensSection>
    </div>
  );
}
