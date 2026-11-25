"use client";

/**
 * Overlap: how much of two funds is the same money.
 *
 * The definition is `/compare`'s, stated once and used once: for each company, the
 * smaller of the two funds' weights, added up (`lookthrough-math-and-qa` §4). It is
 * symmetric, it is a share of a fund and never of the visitor's money, and the
 * numbers are printed in a real table — an overlap is a proportion of two
 * portfolios, and a picture of a matrix would be a heat map with no readable value
 * in it.
 *
 * The rule that keeps the table honest is the coverage band, and it is one rule
 * across the site: 70% and above prints plainly, 60% up to but not including 70%
 * prints with a qualifier that says the number is a floor, below 60% withholds. An
 * overlap can only be too low when a fund cannot place its own weight — the
 * untraced part can hide a company both funds hold, never invent one — so the band
 * decides how loudly the row has to say so. A withheld pair still gets a row: its
 * numbers say "not computed" and the Note column names the fund.
 *
 * The definition itself is not repeated here: the headline links to
 * `/methodology/#overlap`, and each column header carries its own one-line tip, so
 * this lens states no concept twice (R4).
 */

import { TableScroll } from "@/components/TableScroll";
import Link from "next/link";
import { useMemo, useState } from "react";

import { InfoTip } from "@/components/feedback/InfoTip";
import { saveCsv } from "@/lib/export";
import { coverageBand, coverageChip, formatCount, formatShare } from "@/lib/format";
import type { LensProps } from "@/components/workspace/types";

import {
  CellNote,
  LensAnswer,
  LensExport,
  LensProblem,
  LensSection,
  LensState,
} from "./lens-chrome";
import { lensCsvName, overlapCsv, type OverlapCsvRow } from "./lens-csv";
import { lensGateState } from "./lens-gate";
import {
  nextSort,
  pairwiseOverlap,
  pairVerdict,
  type FundPairOverlap,
  type PairState,
  type SortState,
} from "./lens-math";

interface PairRow {
  a: string;
  b: string;
  coverageAPct: number | null;
  coverageBPct: number | null;
  /** The numbers, or `null` when the pair is withheld. */
  numbers: FundPairOverlap | null;
  /** `printed`, `floor` (a qualifier in the Note column) or `withheld` (no numbers). */
  state: PairState;
  /** The qualifier or the reason, in the words the band system uses. */
  note: string | null;
}

type OverlapSortKey =
  "overlap" | "onlyA" | "onlyB" | "sharedCompanies" | "unionCompanies";

/** The numeric columns, in table order. Every one sorts largest first on its first click. */
const NUMERIC_COLUMNS: { key: OverlapSortKey; label: string; tip: string }[] = [
  {
    key: "overlap",
    label: "Overlap",
    tip: "Share of value the two funds hold in the same companies.",
  },
  {
    key: "onlyA",
    label: "Only in A",
    tip: "Share of Fund A in companies Fund B doesn\u2019t hold.",
  },
  {
    key: "onlyB",
    label: "Only in B",
    tip: "Share of Fund B in companies Fund A doesn\u2019t hold.",
  },
  {
    key: "sharedCompanies",
    label: "Companies in common",
    tip: "Companies both funds hold.",
  },
  {
    key: "unionCompanies",
    label: "Companies in either",
    tip: "Companies held by at least one of the two.",
  },
];

const DEFAULT_SORT: SortState<OverlapSortKey> = {
  key: "overlap",
  direction: "descending",
};

/**
 * Order the pairs by one numeric column. A withheld pair has no numbers, so it sits
 * after every computed pair in both directions — reversing the sort must not put the
 * gaps first — and ties fall back to the fund names so rows never swap between renders.
 */
export function sortPairs<
  T extends { a: string; b: string; numbers: FundPairOverlap | null },
>(rows: readonly T[], sort: SortState<OverlapSortKey>): T[] {
  const factor = sort.direction === "ascending" ? 1 : -1;
  return [...rows].sort((left, right) => {
    if (left.numbers === null || right.numbers === null) {
      if (left.numbers !== right.numbers) return left.numbers === null ? 1 : -1;
    } else {
      const difference = left.numbers[sort.key] - right.numbers[sort.key];
      if (difference !== 0) return factor * difference;
    }
    return left.a.localeCompare(right.a) || left.b.localeCompare(right.b);
  });
}

export function OverlapLens({ model }: LensProps) {
  const [sort, setSort] = useState<SortState<OverlapSortKey>>(DEFAULT_SORT);
  const gate = lensGateState(model);
  const ledger = model.ledger;
  const docs = model.fundByTicker;
  const fundWeights = model.split.fundWeights;

  const analysis = useMemo(() => {
    if (!ledger) return null;
    const tickers = Object.keys(fundWeights);
    const pairs = pairwiseOverlap({
      rows: ledger.rows,
      weights: fundWeights,
      tickers,
    });

    const byKey = new Map<string, FundPairOverlap>();
    for (const pair of pairs) byKey.set(`${pair.a}\u0000${pair.b}`, pair);

    /**
     * A fund that is not in the mix at all is not a coverage question, so it is
     * answered before the bands are asked: no filing, or no amount entered.
     */
    const structuralReason = (ticker: string): string | null => {
      if (!docs.has(ticker)) return `${ticker} has no filing`;
      if ((fundWeights[ticker] ?? 0) <= 0) {
        return `${ticker} has no amount in your portfolio`;
      }
      return null;
    };

    const rows: PairRow[] = [];
    for (let index = 0; index < tickers.length; index += 1) {
      const a = tickers[index];
      if (a === undefined) continue;
      for (let other = index + 1; other < tickers.length; other += 1) {
        const b = tickers[other];
        if (b === undefined) continue;

        const coverageAPct = docs.get(a)?.coverage_pct ?? null;
        const coverageBPct = docs.get(b)?.coverage_pct ?? null;
        const structural = [structuralReason(a), structuralReason(b)].filter(
          (reason): reason is string => reason !== null,
        );

        const verdict =
          structural.length > 0
            ? { state: "withheld" as PairState, note: `${structural.join(" and ")}.` }
            : pairVerdict(
                { ticker: a, coveragePct: coverageAPct },
                { ticker: b, coveragePct: coverageBPct },
              );

        rows.push({
          a,
          b,
          coverageAPct,
          coverageBPct,
          numbers:
            verdict.state === "withheld" ? null : (byKey.get(`${a}\u0000${b}`) ?? null),
          state: verdict.state,
          note: verdict.note,
        });
      }
    }

    // The headline names the largest overlap whatever order the reader picks.
    rows.splice(0, rows.length, ...sortPairs(rows, DEFAULT_SORT));

    const best = rows.find((row) => row.numbers !== null) ?? null;
    return { tickers, rows, best };
  }, [ledger, docs, fundWeights]);

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

  const { tickers, rows, best } = analysis;
  const releaseAsOf = model.releaseAsOf ?? "unknown";

  if (tickers.length < 2) {
    return (
      <LensState
        title="Overlap needs two funds"
        body="Your portfolio holds one fund, and an overlap is a comparison between two. Add a second fund and every pair will be listed here; the Companies and Markets lenses already cover what you own today."
      />
    );
  }

  const exportOverlap = () => {
    const csvRows: OverlapCsvRow[] = rows.map((row) => ({
      a: row.a,
      b: row.b,
      overlap: row.numbers === null ? null : row.numbers.overlap,
      onlyA: row.numbers === null ? null : row.numbers.onlyA,
      onlyB: row.numbers === null ? null : row.numbers.onlyB,
      sharedCompanies: row.numbers === null ? null : row.numbers.sharedCompanies,
      unionCompanies: row.numbers === null ? null : row.numbers.unionCompanies,
      coverageAPct: row.coverageAPct,
      coverageBPct: row.coverageBPct,
      state: row.state,
      note: row.note,
    }));
    saveCsv(
      overlapCsv(csvRows, releaseAsOf),
      lensCsvName("overlap", new Date(), releaseAsOf),
    );
  };

  // The answer names the qualifier too: a floor printed in the strip without its
  // reason would be the one place on the page where the number stood alone.
  const answer =
    best === null || best.numbers === null
      ? "No pair of your funds can be compared: at least one fund in every pair is below the 60% coverage floor."
      : `${best.a} and ${best.b} hold ${formatShare(
          best.numbers.overlap,
        )} of their value in the same companies.${best.note === null ? "" : ` ${best.note}`}`;

  // A column of empty cells is not a column: the Note column exists only when some
  // row has something to say in it (P-O-04).
  // A pair that shares no company has nothing for the table to say: twelve funds are 66
  // pairs, and a column of 0.00% rows buries the ones that matter. They are named in
  // one line under the table instead, and the CSV still carries every pair.
  const tableRows = rows.filter(
    (row) => row.numbers === null || row.numbers.sharedCompanies > 0,
  );
  const disjoint = rows.filter(
    (row) => row.numbers !== null && row.numbers.sharedCompanies === 0,
  );
  const showNote = tableRows.some((row) => row.note !== null);

  return (
    <div className="stack">
      <LensProblem model={model} />
      {/* The definition is on `/methodology/#overlap` now, so the headline carries the
          link rather than the paragraph: one concept, explained once, linked from every
          surface that uses it (R4). The link sits at the end of the headline row, small
          and muted, so it cannot compete with the sentence it qualifies. */}
      <div className="row row--between">
        <LensAnswer>{answer}</LensAnswer>
        <Link className="small muted" href="/methodology/#overlap">
          How overlap works
        </Link>
      </div>

      <LensSection
        title="All pairs"
        action={<LensExport label="pairwise overlap" onExport={exportOverlap} />}
      >
        <TableScroll label="Overlap between your funds">
          <table className="table">
            {/* The definition of every column is on `/methodology/#overlap` and in each
                header's tip, so the caption says what the table is for and nothing more
                (R2). It stays a real `<caption>` for a screen reader (H9). */}
            <caption className="visually-hidden">
              Every pair of your funds, sorted by{" "}
              {NUMERIC_COLUMNS.find(
                (column) => column.key === sort.key,
              )?.label.toLowerCase()}
              .
            </caption>
            <thead>
              <tr>
                <th scope="col">Fund A</th>
                <th scope="col">Fund B</th>
                {NUMERIC_COLUMNS.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className="num"
                    aria-sort={sort.key === column.key ? sort.direction : "none"}
                  >
                    <button
                      type="button"
                      className="table__sort"
                      onClick={() => setSort(nextSort(sort, column.key, "descending"))}
                    >
                      {column.label}
                    </button>
                    <InfoTip label={column.label} inline>
                      {column.tip}
                    </InfoTip>
                  </th>
                ))}
                {showNote ? <th scope="col">Note</th> : null}
              </tr>
            </thead>
            <tbody>
              {sortPairs(tableRows, sort).map((row) => (
                <tr key={`${row.a}\u0000${row.b}`}>
                  <th scope="row">
                    <span className="mono">{row.a}</span>
                    {row.coverageAPct === null ||
                    coverageBand(row.coverageAPct) === "full" ? null : (
                      <CellNote>{coverageChip(row.coverageAPct)}</CellNote>
                    )}
                  </th>
                  <td>
                    <span className="mono">{row.b}</span>
                    {row.coverageBPct === null ||
                    coverageBand(row.coverageBPct) === "full" ? null : (
                      <CellNote>{coverageChip(row.coverageBPct)}</CellNote>
                    )}
                  </td>
                  {row.numbers === null ? (
                    <td className="num muted">not computed</td>
                  ) : (
                    <td className="num">{formatShare(row.numbers.overlap)}</td>
                  )}
                  <td className="num">
                    {row.numbers === null ? "—" : formatShare(row.numbers.onlyA)}
                  </td>
                  <td className="num">
                    {row.numbers === null ? "—" : formatShare(row.numbers.onlyB)}
                  </td>
                  <td className="num">
                    {row.numbers === null
                      ? "—"
                      : formatCount(row.numbers.sharedCompanies)}
                  </td>
                  <td className="num">
                    {row.numbers === null ? "—" : formatCount(row.numbers.unionCompanies)}
                  </td>
                  {showNote ? (
                    <td className="small muted">{row.note === null ? "" : row.note}</td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        {disjoint.length > 0 ? (
          <p className="small muted">
            {disjoint.length === 1 ? "1 pair shares" : `${disjoint.length} pairs share`}{" "}
            no companies, so {disjoint.length === 1 ? "it is" : "they are"} not listed:{" "}
            {disjoint.map((row) => `${row.a}–${row.b}`).join(", ")}.
          </p>
        ) : null}
      </LensSection>
    </div>
  );
}
