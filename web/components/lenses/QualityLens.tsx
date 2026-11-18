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
 *
 * The lens states its figures and links its definitions: coverage, the bands and the
 * split of what is not traced live at `/methodology/#coverage` and
 * `/methodology/#look-through`, and the per-column meaning is a one-line tip on the
 * header, so no concept is explained twice (R4).
 */

import { useMemo } from "react";

import { InfoTip } from "@/components/feedback/InfoTip";
import { saveCsv } from "@/lib/export";
import {
  coverageBand,
  formatCount,
  formatCoveragePct,
  formatDateLong,
  formatFreshnessShort,
  formatShare,
} from "@/lib/format";
import type { LensProps } from "@/components/workspace/types";

import {
  CellNote,
  CoverageChip,
  LensAnswer,
  LensExport,
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

  // CN_ZERO_ROW: a row that prints as 0.00% is not a share of anything, so it is not
  // printed. "Named companies" and "Total" are never hidden this way.
  const showCashRow = formatShare(totals.cash) !== "0.00%";

  // P-Q-05, and MA-08 behind it: a filed position that rounds to zero basis points is
  // a line, never money, so the Count column and the Weight column do not count the
  // same things. The tip says so once, on the header, instead of under the table.
  const zeroPositions = unmapped.positions - unmapped.positions_with_weight;
  const countTip =
    zeroPositions > 0
      ? `Positions that carry weight. ${formatCount(zeroPositions)} more round to zero and aren't counted.`
      : "Positions that carry weight.";

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
        {covered} of your invested weight is traced to named companies.
      </LensAnswer>

      <LensSection
        title="Coverage by fund"
        action={<LensExport label="coverage and filing dates" onExport={exportQuality} />}
      >
        <div className="table-wrap">
          <table className="table">
            {/* The caption says what the table is and stays visually hidden (H9, R2);
                each column's meaning is a one-line tip, and the band rule itself is on
                `/methodology/#coverage` (R4). */}
            <caption className="visually-hidden">
              Coverage by fund, least covered first.
            </caption>
            <thead>
              <tr>
                <th scope="col">Fund</th>
                <th scope="col" className="num">
                  Weight
                  <InfoTip label="Weight">Share of your whole portfolio.</InfoTip>
                </th>
                <th scope="col" className="num">
                  Weight with no company
                  <InfoTip label="Weight with no company">
                    {
                      "Part of this fund's weight with no company behind it: unmatched securities, cash and derivatives."
                    }
                  </InfoTip>
                </th>
                <th scope="col" className="num">
                  Coverage
                  {/* `concepts.coverage.popover` (copy-spec.yaml:58): the same sentence
                      the coverage chip carries, so the band rule has one wording. */}
                  <InfoTip label="Coverage">
                    {
                      "Share of a fund's weight we can trace to named companies. 70% or more is full, 60–70% partial, under 60% withheld."
                    }
                  </InfoTip>
                </th>
                <th scope="col">Holdings as of</th>
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
                      ? formatFreshnessShort(row.asOf, row.filedAt, row.lagDays)
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
                      oldest {formatDateLong(gate.ledger.oldest_as_of)}
                      {gate.ledger.max_lag_days === null
                        ? ""
                        : ` · slowest ${formatCount(gate.ledger.max_lag_days)} days`}
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

      <LensSection title="Where your money is">
        <div className="table-wrap">
          <table className="table">
            {/* The caption is the table's name, visually hidden (H9, R2). What each row
                is, and the two rules the numbers follow — a position that rounds to zero
                basis points is a line and never money (MA-08), and the filing adjustment
                is signed — are the row tips and the count tip. */}
            <caption className="visually-hidden">
              Every part of your portfolio, adding to 100%.
            </caption>
            <thead>
              <tr>
                <th scope="col">What it is</th>
                <th scope="col" className="num">
                  Weight
                </th>
                <th scope="col" className="num">
                  Count
                  <InfoTip label="Count">{countTip}</InfoTip>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Named companies</th>
                <td className="num">{formatShare(totals.resolved)}</td>
                <td className="num">{formatCount(gate.ledger.rows.length)}</td>
              </tr>
              <tr>
                <th scope="row">
                  Unmatched securities
                  <InfoTip label="Unmatched securities">
                    {"Securities in a fund that we couldn't match to a company."}
                  </InfoTip>
                </th>
                <td className="num">{formatShare(totals.unmatchedSecurities)}</td>
                <td className="num">{formatCount(unmapped.securities_with_weight)}</td>
              </tr>
              <tr>
                <th scope="row">Cash and derivatives in funds</th>
                <td className="num">{formatShare(totals.unmatchedCashDerivatives)}</td>
                <td className="num">
                  {formatCount(unmapped.cash_and_derivatives_with_weight)}
                </td>
              </tr>
              {showCashRow ? (
                <tr>
                  <th scope="row">Your cash</th>
                  <td className="num">{formatShare(totals.cash)}</td>
                  <td className="num">—</td>
                </tr>
              ) : null}
              {totals.unallocated > 0 ? (
                <tr>
                  <th scope="row">Not entered</th>
                  <td className="num">{formatShare(totals.unallocated)}</td>
                  <td className="num">—</td>
                </tr>
              ) : null}
              <tr>
                <th scope="row">
                  Filing adjustment
                  <InfoTip label="Filing adjustment">
                    {
                      "Difference between a fund's reported total and its listed positions. Usually negative."
                    }
                  </InfoTip>
                </th>
                <td className="num">{formatShare(totals.filedOvershoot)}</td>
                <td className="num">—</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td className="num">{formatShare(totals.total)}</td>
                <td className="num" />
              </tr>
            </tfoot>
          </table>
        </div>
      </LensSection>
    </div>
  );
}
