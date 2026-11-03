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
 * two questions a table of funds gets asked, and the caption says which sort is
 * on and what each column means. The sort is a real button inside a column
 * header, with `aria-sort` on the header where ARIA puts it.
 */

import { useMemo, useState } from "react";

import {
  effectiveHoldingsForFund,
  type EffectiveHoldings,
} from "@/lib/effective-holdings";
import { saveCsv } from "@/lib/export";
import { formatCount, formatEffective, formatFreshness, formatShare } from "@/lib/format";
import { Term } from "@/components/prose/Term";
import type { LensProps } from "@/components/workspace/types";

import {
  CellNote,
  CoverageChip,
  LensExport,
  LensLede,
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
}> = [
  { key: "ticker", label: "Fund", numeric: false, first: "ascending" },
  { key: "weight", label: "Weight", numeric: true, first: "descending" },
  { key: "positions", label: "Positions", numeric: true, first: "descending" },
  { key: "coveragePct", label: "Coverage", numeric: true, first: "descending" },
  { key: "asOf", label: "Reporting period, filed", numeric: false, first: "descending" },
  { key: "top10Share", label: "Your top ten", numeric: true, first: "descending" },
];

/**
 * The closing row is not a total, and this is the sentence that says so wherever the
 * label is hovered or read out. It is one sentence because a tooltip is not a caption.
 */
const PORTFOLIO_ROW_HINT =
  "Not an average of the rows above. Companies held by more than one fund merge, which lowers both counts.";

const COLUMN_LABEL: Record<FundSortKey, string> = {
  ticker: "Fund",
  weight: "Weight",
  positions: "Positions",
  coveragePct: "Coverage",
  asOf: "Reporting period",
  top10Share: "Your top ten",
};

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
  const sortLabel = COLUMN_LABEL[sort.key];

  const exportFunds = () => {
    saveCsv(
      fundsCsv(sorted, releaseAsOf, pair),
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

  return (
    <div className="stack">
      <LensProblem model={model} />
      <LensLede>
        One row per fund in your portfolio: its weight, how many lines its filing has, how
        much of its weight resolved to a company, when that filing covers and when it
        reached us, and how much of your ten largest companies it supplies.
      </LensLede>

      <LensSection
        title="Your funds"
        action={<LensExport label="funds in your mix" onExport={exportFunds} />}
      >
        <div className="table-wrap">
          <table className="table">
            <caption>
              Sorted by {sortLabel}, {directionWords(sort.key, sort.direction)}. Every
              heading is a button: choose it to sort by that column, choose it again to
              reverse. Weight is a share of your whole portfolio, so the column adds up to
              the weight your funds carry — the rest is your direct positions and cash.
              Positions is the number of lines in the fund&rsquo;s own filing, resolved or
              not, and the same company can be in several funds, so that column is not
              added up. Coverage is the share of a fund&rsquo;s weight that resolved to a
              company: 70% and above is full, 60% to just under 70% is partial, below 60%
              is withheld and no concentration figure is shown for that fund anywhere.
              Your top ten is the share of your ten largest company lines that came
              through this fund — a share of the top ten, not of the fund, and the same
              ten companies for every row. A fund below full coverage contributes only the
              part of its filing that resolved, so its share there is a floor rather than
              a ceiling. Effective holdings is the pair of equal-sized-holdings counts
              read for each fund on its own, at 100% of that fund rather than as a share
              of your money: Core counts the large positions, Broad counts everything. A
              fund below 60% coverage has both withheld. The last two rows are the funds
              added up and then your portfolio as a whole — the counts there are computed
              once over your merged companies, so they are not the column added up, and
              the row says so. The funds total adds unrounded values, so it can differ
              from the column by a hundredth.
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
                    </th>
                  );
                })}
                {/* The only grouped pair in the table: two counts that are read
                    together and mean nothing apart, each with its own word. */}
                <th scope="colgroup" colSpan={2} className="num">
                  Effective holdings
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
                      ? formatFreshness(row.asOf, row.filedAt, row.lagDays)
                      : "no filing"}
                  </td>
                  <td className="num">
                    {row.top10Share === null ? "—" : formatShare(row.top10Share)}
                  </td>
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
                  <CellNote>of your ten largest; the rest is direct</CellNote>
                </td>
                <td className="num" />
                <td className="num" />
              </tr>
              <tr>
                <th
                  scope="row"
                  title={PORTFOLIO_ROW_HINT}
                  aria-describedby="funds-portfolio-hint"
                >
                  Your portfolio
                </th>
                <td className="num" />
                <td className="num" />
                <td className="num" />
                <td />
                <td className="num" />
                <td className="num">{portfolioCell("core")}</td>
                <td className="num">{portfolioCell("broad")}</td>
              </tr>
            </tfoot>
          </table>
          {/* The same sentence as the label's `title`, for a reader who never hovers:
              a tooltip is the only affordance this table has for a hint, and `title`
              alone is not reachable from the keyboard. */}
          <p id="funds-portfolio-hint" className="visually-hidden">
            {PORTFOLIO_ROW_HINT}
          </p>
        </div>
      </LensSection>
    </div>
  );
}
