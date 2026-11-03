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
 * numbers say "not computed" and the Note column names the fund and its percentage.
 */

import { useMemo } from "react";

import { saveCsv } from "@/lib/export";
import { coverageChip, formatCount, formatShare } from "@/lib/format";
import type { LensProps } from "@/components/workspace/types";

import {
  CellNote,
  LensAnswer,
  LensExport,
  LensLede,
  LensProblem,
  LensSection,
  LensState,
} from "./lens-chrome";
import { lensCsvName, overlapCsv, type OverlapCsvRow } from "./lens-csv";
import { lensGateState } from "./lens-gate";
import {
  pairwiseOverlap,
  pairVerdict,
  type FundPairOverlap,
  type PairState,
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

export function OverlapLens({ model }: LensProps) {
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

    // Pairs with numbers first (largest overlap first), then the withheld ones in
    // name order, so a reader who wants the gap can find it.
    rows.sort((left, right) => {
      const leftOverlap = left.numbers === null ? -1 : left.numbers.overlap;
      const rightOverlap = right.numbers === null ? -1 : right.numbers.overlap;
      if (leftOverlap !== rightOverlap) return rightOverlap - leftOverlap;
      return left.a.localeCompare(right.a) || left.b.localeCompare(right.b);
    });

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

  return (
    <div className="stack">
      <LensProblem model={model} />
      <LensAnswer>{answer}</LensAnswer>
      <LensLede>
        Overlap is the share of value two funds hold in the same companies: for each
        company, the smaller of the two funds&rsquo; weights, added up. It is a share of a
        fund, never a share of your money, and the two sides of a pair are treated the
        same way — the overlap of A with B is the overlap of B with A. A pair is compared
        when both funds are in at least the partial coverage band, 60% of their weight
        traced. A fund in the partial band, 60% up to but not including 70%, leaves up to
        40 points of itself untraced, and untraced weight can only hide holdings the two
        funds have in common — so that row says in words that its number is a floor. A
        fund below 60% is not compared at all. Every overlap here is a floor rather than
        an exact figure, including the ones with no note, because no fund places all of
        itself.
      </LensLede>

      <LensSection
        title="Every pair"
        action={<LensExport label="pairwise overlap" onExport={exportOverlap} />}
      >
        <div className="table-wrap">
          <table className="table">
            <caption>
              One row per pair of funds in your portfolio, in the order your portfolio
              lists them. A is the fund in the first column and B the one in the second.
              Overlap is the sum over companies of the smaller of the two weights; Only in
              A is the part of A&rsquo;s portfolio in companies B does not hold, and Only
              in A plus Overlap is the share of A that resolved to a company — the rest of
              A is weight with no company. Companies in common counts the companies both
              hold with positive weight; Companies in either is the union the two were
              compared over. Overlap, Only in A and Only in B are shares of a fund, so a
              pair with a small overlap is not a pair of small funds. Rows are sorted by
              overlap, largest first, and a pair that is withheld is listed after them.
              Note carries the qualifier: a fund in the partial band makes the row a
              floor, and a fund below the 60% floor withholds it, with its percentage
              printed.
            </caption>
            <thead>
              <tr>
                <th scope="col">Fund A</th>
                <th scope="col">Fund B</th>
                <th scope="col" className="num">
                  Overlap
                </th>
                <th scope="col" className="num">
                  Only in A
                </th>
                <th scope="col" className="num">
                  Only in B
                </th>
                <th scope="col" className="num">
                  Companies in common
                </th>
                <th scope="col" className="num">
                  Companies in either
                </th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.a}\u0000${row.b}`}>
                  <th scope="row">
                    <span className="mono">{row.a}</span>
                    {row.coverageAPct === null ? null : (
                      <CellNote>{coverageChip(row.coverageAPct)}</CellNote>
                    )}
                  </th>
                  <td>
                    <span className="mono">{row.b}</span>
                    {row.coverageBPct === null ? null : (
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
                  <td className="small muted">{row.note === null ? "" : row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </LensSection>
    </div>
  );
}
