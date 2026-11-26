"use client";

/**
 * Funds: what each fund in the mix is, and how much of you it is.
 *
 * One row per fund, and each row carries the four things that make its share
 * readable rather than a bare percentage: the weight, how many positions the
 * filing has, the coverage band with its percentage, and the three filing dates
 * (the end of the reporting period, the day it was filed, and how many days ago
 * that was). The last group is what the fund is equivalent to on its own: the
 * pair of equal-sized-holdings counts, read at 100% of the fund rather than as a
 * share of the visitor's money, because that is the only way two funds in one
 * table are comparable. The row above it — how much of your ten largest companies
 * came through this fund — exists only because the others do.
 *
 * The effective pair gets its own grouped header and its own closing row: a fund's
 * two counts are its own, while the portfolio's are computed once over the merged
 * companies, so the last row is not the sum or the average of the rows above it and
 * says so.
 *
 * Sortable, because "which fund is newest" and "which fund is largest" are the
 * two questions a table of funds gets asked. The sort is a real button inside a
 * column header, with `aria-sort` on the header where ARIA puts it. The caption is
 * one sentence for a screen reader — which sort is on — and what each column means
 * lives in the header's own tooltip, beside the sort button rather than inside it.
 */

import { useMemo, useState } from "react";

import {
  effectiveHoldingsForFund,
  type EffectiveHoldings,
} from "@/lib/effective-holdings";
import { saveCsv } from "@/lib/export";
import {
  classesByFund,
  classOf,
  documentsCarryFees,
  feeFigure,
  portfolioFee,
} from "@/lib/fees";
import {
  formatCount,
  formatEffective,
  formatFeeAverage,
  formatFeePct,
  formatFreshnessShort,
  formatKnownShare,
  formatShare,
} from "@/lib/format";
import { COVERAGE_POPOVER } from "@/lib/coverage";
import { InfoTip } from "@/components/feedback/InfoTip";
import { Term } from "@/components/prose/Term";
import { TableScroll } from "@/components/TableScroll";
import type { LensProps } from "@/components/workspace/types";

import {
  CellNote,
  CoverageChip,
  LensExport,
  LensProblem,
  LensSection,
  LensState,
} from "./lens-chrome";
import { fundsCsv, lensCsvName } from "./lens-csv";
import { lensGateState } from "./lens-gate";
import {
  fundMixRows,
  nextSort,
  sortBy,
  top10Attribution,
  type FundMixRow,
  type SortState,
} from "./lens-math";

type FundSortKey =
  "ticker" | "weight" | "positions" | "coveragePct" | "asOf" | "top10Share";

const COLUMNS: Array<{
  key: FundSortKey;
  label: string;
  numeric: boolean;
  /** The direction the first click on this column sorts in. */
  first: "ascending" | "descending";
  /** The header's tooltip (P-F-03), verbatim from the copy spec. A column with no
   *  entry prints its label alone; "Fund" needs no explanation. */
  tip?: string;
}> = [
  { key: "ticker", label: "Fund", numeric: false, first: "ascending" },
  {
    key: "weight",
    label: "Weight",
    numeric: true,
    first: "descending",
    tip: "Share of your whole portfolio.",
  },
  {
    key: "positions",
    label: "Positions",
    numeric: true,
    first: "descending",
    tip: "Lines in the fund's own filing, matched or not.",
  },
  {
    key: "coveragePct",
    label: "Coverage",
    numeric: true,
    first: "descending",
    tip: COVERAGE_POPOVER,
  },
  {
    key: "asOf",
    label: "Holdings as of",
    numeric: false,
    first: "descending",
    tip: "Quarter-end the holdings describe, the filing date, and the days between.",
  },
  {
    key: "top10Share",
    label: "Your top ten",
    numeric: true,
    first: "descending",
    tip: "Share of your ten largest companies that comes through this fund.",
  },
];

/**
 * The fee column is not one of `COLUMNS`: it has no sort key, no sort button and no
 * `aria-sort`. An expense ratio is a stated fact about each fund, and a table the visitor
 * can order by it is a ranking of funds by cost (the operator's D2, 2026-11-24).
 */
const FEE_TIP =
  "The expense ratio the fund's prospectus states for the class you entered, net of waivers where it says so. It describes the fund, not your money.";

/** The two counts share one grouped header, which is why its tip is not a column's. */
const EFFECTIVE_HOLDINGS_TIP =
  "Counted inside each fund on its own, not as a share of your money.";

/**
 * The closing row is not a total, and this is the sentence that says so where the row's
 * label is hovered, focused or read out. It is one sentence because a tooltip is not a
 * caption.
 */
const PORTFOLIO_ROW_TIP =
  "Counted on your merged companies, not averaged from the rows above.";

/**
 * What the "All funds" fee cell says about itself: the average is a weighted mean over the
 * funds whose fee the prospectus states, never over all of them, and the share it covers is
 * always printed. Under 60% of fund weight the average is withheld and says why.
 */
function feeSummaryNote(summary: ReturnType<typeof portfolioFee>): string {
  if (summary === null) return "no fund weight";
  const known = formatKnownShare(summary.knownPct);
  if (summary.suppressed) {
    return `weighted average withheld: fees known for ${known} of fund weight`;
  }
  return `weighted average, fees known for ${known} of fund weight`;
}

/** The caption says which sort is on in the column's own words, not "descending". */
function directionWords(key: FundSortKey, direction: "ascending" | "descending"): string {
  const ascending = direction === "ascending";
  if (key === "ticker") return ascending ? "A first" : "Z first";
  if (key === "asOf") return ascending ? "oldest first" : "newest first";
  return ascending ? "smallest first" : "largest first";
}

/**
 * A row with no filing cannot occur while the gate says ready — a fund with no
 * document is either still pending or failed, and both block every lens. Such a
 * row, if it ever appeared, keeps its position rather than being sorted as if its
 * missing number were a zero.
 */
function compareMissing(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return a - b;
}

function numberCompare(a: number | null, b: number | null): number {
  return compareMissing(a, b) ?? 0;
}

const COMPARE: Record<FundSortKey, (a: FundMixRow, b: FundMixRow) => number> = {
  ticker: (a, b) => a.ticker.localeCompare(b.ticker),
  weight: (a, b) => a.weight - b.weight || a.ticker.localeCompare(b.ticker),
  positions: (a, b) =>
    numberCompare(a.positions, b.positions) || a.ticker.localeCompare(b.ticker),
  coveragePct: (a, b) =>
    numberCompare(a.coveragePct, b.coveragePct) || a.ticker.localeCompare(b.ticker),
  asOf: (a, b) =>
    (a.asOf ?? "").localeCompare(b.asOf ?? "") || a.ticker.localeCompare(b.ticker),
  top10Share: (a, b) =>
    numberCompare(a.top10Share, b.top10Share) || a.ticker.localeCompare(b.ticker),
};

export function FundsLens({ model }: LensProps) {
  const gate = lensGateState(model);
  const [sort, setSort] = useState<SortState<FundSortKey>>({
    key: "weight",
    direction: "descending",
  });

  const ledger = model.ledger;
  const docs = model.fundByTicker;
  const fundWeights = model.split.fundWeights;
  // Whether the portfolio holds a stock directly, which is what decides the words
  // under the "All funds" top-ten figure: some of those ten may be the visitor's own
  // positions rather than a fund's (CN_DIRECT_REST). A length, never a number.
  const hasDirectHoldings = model.split.direct.length > 0;

  const rows = useMemo(() => {
    if (!ledger) return null;
    const top10 = top10Attribution(ledger.rows);
    const built = fundMixRows({
      tickers: Object.keys(fundWeights),
      weights: fundWeights,
      docs,
      top10,
    });
    // Each fund's own pair: the fund at 100%, with its own coverage band and its own
    // merge, which is what makes two rows in this table comparable to each other.
    const pair = new Map<string, EffectiveHoldings>();
    for (const row of built) {
      const document = docs.get(row.ticker);
      if (document) pair.set(row.ticker, effectiveHoldingsForFund(document));
    }
    return {
      rows: built,
      top10,
      sorted: sortBy(built, sort, COMPARE),
      pair,
      // The portfolio's own pair, merged across every fund and direct position at
      // once. Read from the ledger, never summed or averaged down the column.
      portfolio: ledger.effective,
    };
  }, [ledger, docs, fundWeights, sort]);

  // Expense ratios, when the fund documents in hand carry them at all. A release that did
  // not read prospectuses has no Fee column: "not stated" there would be a claim about a fund
  // this release never looked up.
  const showFees = documentsCarryFees(docs.values());
  const classes = classesByFund(model.portfolio.entries);
  const feeSummary = showFees ? portfolioFee(fundWeights, classes, docs) : null;

  if (gate.kind === "blocked") {
    return <LensState title={gate.title} body={gate.body} />;
  }

  if (!rows) {
    return (
      <LensState
        title="Working out the look-through"
        body="The ledger is aggregating the funds' filings. This lens reads only the finished ledger, so it waits for it."
      />
    );
  }

  const releaseAsOf = model.releaseAsOf ?? "unknown";
  const { sorted, top10, pair, portfolio } = rows;

  if (sorted.length === 0) {
    return (
      <LensState
        title="No funds in this portfolio"
        body="Everything you hold is a direct position or cash. This lens has one row per fund, so with no fund there is nothing to list; the Companies and Markets lenses still cover what you own."
      />
    );
  }

  const totalWeight = sorted.reduce((sum, row) => sum + row.weight, 0);
  const totalTop10 = sorted.reduce((sum, row) => sum + (row.top10Share ?? 0), 0);
  // The column's own words, from the one list that also sets the header's label: a second
  // label map is how "Reporting period" and "Reporting period, filed" came to disagree.
  const sortColumn = COLUMNS.find((column) => column.key === sort.key);
  const sortLabel = sortColumn ? sortColumn.label : sort.key;

  const exportFunds = () => {
    saveCsv(
      fundsCsv(
        sorted,
        releaseAsOf,
        pair,
        showFees
          ? (ticker) => {
              const entry = model.portfolio.entries.find(
                (candidate) => candidate.kind === "fund" && candidate.key === ticker,
              );
              const classTicker = classOf(entry ?? { key: ticker });
              return { classTicker, figure: feeFigure(docs.get(ticker), classTicker) };
            }
          : undefined,
      ),
      lensCsvName("funds", new Date(), releaseAsOf),
    );
  };

  /**
   * One cell of the pair. A fund below the floor has no count and shows the table's
   * no-number glyph: the row's own Coverage cell names the band and the percentage,
   * which is the explanation, and a zero here would read as a measurement.
   */
  const pairCell = (ticker: string, key: "core" | "broad"): string => {
    const value = pair.get(ticker)?.[key] ?? null;
    return value === null ? "—" : formatEffective(value);
  };

  const portfolioCell = (key: "core" | "broad"): string => {
    const value = portfolio[key];
    return value === null ? "—" : formatEffective(value);
  };

  /**
   * One fund's fee: the figure the prospectus says investors pay, then what it is. The
   * class shown is the one the visitor entered; a class the document has no row for reads
   * "not stated", never a sibling class's figure.
   */
  const feeCell = (row: FundMixRow) => {
    const entry = model.portfolio.entries.find(
      (candidate) => candidate.kind === "fund" && candidate.key === row.ticker,
    );
    const classTicker = classOf(entry ?? { key: row.ticker });
    const figure = feeFigure(docs.get(row.ticker), classTicker);
    if (!figure) {
      return (
        <td className="num">
          —<CellNote>{classTicker} · not stated</CellNote>
        </td>
      );
    }
    return (
      <td className="num">
        {formatFeePct(figure.value)}
        <CellNote>
          {classTicker} · {figure.note}
          {figure.before === null
            ? ""
            : `; ${formatFeePct(figure.before)} before waivers`}
        </CellNote>
      </td>
    );
  };

  return (
    <div className="stack">
      <LensProblem model={model} />

      <LensSection
        title="Your funds"
        action={<LensExport label="funds in your mix" onExport={exportFunds} />}
      >
        {/* Eight columns do not fit the lens column, so the table scrolls sideways.
            `TableScroll` keeps a scrollbar at the bottom of the viewport for as long as
            the table is on screen, because the native one is below the fold on any
            portfolio with more than a few funds. */}
        <TableScroll label="Your funds">
          <table className="table">
            {/* One sentence, for a screen reader: the columns explain themselves through
                their header tips and the sort state through `aria-sort` (P-F-02). */}
            <caption className="visually-hidden">
              Your funds. Sorted by {sortLabel},{" "}
              {directionWords(sort.key, sort.direction)}.
            </caption>
            <thead>
              <tr>
                {COLUMNS.map((column) => {
                  const active = sort.key === column.key;
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      rowSpan={2}
                      className={column.numeric ? "num" : undefined}
                      aria-sort={active ? sort.direction : "none"}
                    >
                      <button
                        type="button"
                        className="table__sort"
                        onClick={() =>
                          setSort((current) =>
                            nextSort(current, column.key, column.first),
                          )
                        }
                      >
                        {column.label}
                      </button>
                      {/* Beside the sort button, never inside it: a button in a button is
                          two controls in one tab stop and no defined activation. */}
                      {column.tip ? (
                        <InfoTip label={column.label} inline>
                          {column.tip}
                        </InfoTip>
                      ) : null}
                    </th>
                  );
                })}
                {showFees ? (
                  <th scope="col" rowSpan={2} className="num">
                    Expense ratio
                    <InfoTip label="Expense ratio" inline>
                      {FEE_TIP}
                    </InfoTip>
                  </th>
                ) : null}
                {/* The only grouped pair in the table: two counts that are read
                    together and mean nothing apart, each with its own word. */}
                <th scope="colgroup" colSpan={2} className="num">
                  Effective holdings
                  <InfoTip label="Effective holdings">{EFFECTIVE_HOLDINGS_TIP}</InfoTip>
                </th>
              </tr>
              <tr>
                <th scope="col" className="num">
                  <Term name="core">Core</Term>
                </th>
                <th scope="col" className="num">
                  <Term name="broad">Broad</Term>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr key={row.ticker}>
                  <th scope="row">
                    <span className="mono">{row.ticker}</span>
                    {row.name ? <CellNote>{row.name}</CellNote> : null}
                  </th>
                  <td className="num">{formatShare(row.weight)}</td>
                  <td className="num">
                    {row.positions === null ? "no filing" : formatCount(row.positions)}
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
                  <td className="num">
                    {row.top10Share === null ? "—" : formatShare(row.top10Share)}
                  </td>
                  {showFees ? feeCell(row) : null}
                  <td className="num">{pairCell(row.ticker, "core")}</td>
                  <td className="num">{pairCell(row.ticker, "broad")}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">All funds</th>
                <td className="num">{formatShare(totalWeight)}</td>
                <td className="num" />
                <td className="num" />
                <td />
                <td className="num">
                  {top10.total > 0 ? formatShare(totalTop10) : "—"}
                  {/* CN_DIRECT_REST: the rest of the top ten is direct only when the
                      portfolio has a direct holding to put there. */}
                  <CellNote>
                    {hasDirectHoldings
                      ? "of your top ten; the rest is direct"
                      : "of your top ten"}
                  </CellNote>
                </td>
                {showFees ? (
                  <td className="num">
                    {feeSummary?.average == null
                      ? "—"
                      : formatFeeAverage(feeSummary.average)}
                    <CellNote>{feeSummaryNote(feeSummary)}</CellNote>
                  </td>
                ) : null}
                <td className="num" />
                <td className="num" />
              </tr>
              <tr>
                <th scope="row">
                  Your portfolio
                  <InfoTip label="Your portfolio">{PORTFOLIO_ROW_TIP}</InfoTip>
                </th>
                <td className="num" />
                <td className="num" />
                <td className="num" />
                <td />
                <td className="num" />
                {showFees ? <td className="num" /> : null}
                <td className="num">{portfolioCell("core")}</td>
                <td className="num">{portfolioCell("broad")}</td>
              </tr>
            </tfoot>
          </table>
        </TableScroll>
      </LensSection>
    </div>
  );
}
