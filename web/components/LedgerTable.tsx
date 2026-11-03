"use client";

/**
 * The ledger, as a real table.
 *
 * A table rather than a list of divs, because the accessibility contract is
 * specific: screen-reader table navigation, `scope`, and `aria-sort` on the
 * column that is sorted. Sorting is a view concern and never changes the numbers.
 *
 * Row height is fixed by the stylesheet (`--row`) and the wrapper is a single
 * scroll container, so windowing can be added for the day-4 universe without
 * touching this markup.
 */

import { useMemo, useState } from "react";

import { benchmarkDelta } from "@/lib/benchmark";
import { flagEmoji } from "@/lib/country-flag";
import { TIER_AS_OF, tierOf } from "@/lib/country-tier";
import { formatCount, formatShare, formatSignedShare } from "@/lib/format";
import type { BenchmarkFacts, LedgerRow } from "@/lib/types";

type SortKey = "weight" | "benchmark" | "name" | "holder_count";
type Direction = "ascending" | "descending";

function compare(a: LedgerRow, b: LedgerRow, key: SortKey): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name, "en");
    case "holder_count":
      return a.holder_count - b.holder_count;
    case "benchmark":
      return (a.benchmark_weight ?? 0) - (b.benchmark_weight ?? 0);
    case "weight":
      return a.weight - b.weight;
  }
}

const DEFAULTS: Record<SortKey, Direction> = {
  weight: "descending",
  benchmark: "descending",
  name: "ascending",
  holder_count: "descending",
};

/** What each sort is called in the caption, in words a reader already knows. */
const SORT_LABEL: Record<SortKey, string> = {
  name: "company name",
  weight: "portfolio weight",
  benchmark: "benchmark weight",
  holder_count: "number of funds",
};

/**
 * The bracket's ink class, from the sign alone: green above the benchmark, red below,
 * `--muted` at an exact match — a difference of zero has no side to be on, so it gets no
 * ink. Written here rather than derived in CSS from a data attribute because the sign is
 * arithmetic (`formatSignedShare` owns the direction) while the row's `data-country` owns
 * the edge; two channels, two selectors, no shared cell.
 */
function deltaInkClass(delta: number): string {
  if (delta > 0) return "delta delta--up";
  if (delta < 0) return "delta delta--down";
  return "delta";
}

export function LedgerTable({
  rows,
  limit,
  benchmark,
  onSelect,
}: {
  /** Every company in the ledger. Sorting applies to all of them, not to a page. */
  rows: LedgerRow[];
  /** Render at most this many, after sorting. Absent means all of them. */
  limit?: number;
  /**
   * The fixed benchmark ([ADR-0015](../../../docs/04-decisions/ADR-0015-vt-benchmark.md)).
   * Its presence is what draws the comparison column: without a benchmark there is
   * nothing to compare, and the table says nothing rather than printing zeros.
   */
  benchmark?: BenchmarkFacts | null;
  /** Opens the company drawer. Without it the name is plain text. */
  onSelect?: (row: LedgerRow) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; direction: Direction }>({
    key: "weight",
    direction: "descending",
  });

  const sorted = useMemo(() => {
    const factor = sort.direction === "ascending" ? 1 : -1;
    return [...rows].sort(
      (a, b) =>
        factor * compare(a, b, sort.key) || (a.company_id < b.company_id ? -1 : 1),
    );
  }, [rows, sort]);

  function toggle(key: SortKey) {
    setSort((previous) =>
      previous.key === key
        ? {
            key,
            direction: previous.direction === "descending" ? "ascending" : "descending",
          }
        : { key, direction: DEFAULTS[key] },
    );
  }

  const ariaSort = (key: SortKey) => (sort.key === key ? sort.direction : "none");

  // Sorting the whole ledger before slicing is the point: sorting only the page
  // would answer "which of these 100 funds hold this" instead of "which company do
  // most of my funds hold".
  const total = rows.length;
  const shown = limit === undefined ? sorted.length : Math.min(limit, sorted.length);
  const visible = shown === sorted.length ? sorted : sorted.slice(0, shown);
  const paged = shown < total;
  // Only a portfolio that holds a stock directly gets the sentence, and only then
  // is a shaded row on screen to explain.
  const anyDirect = rows.some((entry) => entry.held_directly);
  // The country sentence follows the same rule as the shading one: a caption that
  // explains a tag no row carries is noise, so it appears only when a row has one.
  const anyCountry = rows.some((entry) => Boolean(entry.country));

  return (
    <div className="table-wrap">
      <table className="ledger">
        <caption>
          {paged
            ? sort.key === "weight" && sort.direction === "descending"
              ? `Showing the top ${formatCount(shown)} of ${formatCount(total)} companies by portfolio weight.`
              : `Showing ${formatCount(shown)} of ${formatCount(total)} companies, sorted by ${SORT_LABEL[sort.key]}.`
            : `${formatCount(total)} ${total === 1 ? "company" : "companies"}, after look-through, sorted by ${SORT_LABEL[sort.key]}.`}{" "}
          Each company is counted once. Weight is this company&apos;s share of the whole
          portfolio, not of any one fund.
          {benchmark
            ? " The " +
              benchmark.ticker +
              " column is this company's share of " +
              benchmark.ticker +
              "'s own portfolio — the benchmark's holding, not yours. The figure in" +
              " brackets is your weight minus " +
              benchmark.ticker +
              "'s, in percentage points: negative means you hold less of the company" +
              " than " +
              benchmark.ticker +
              " does, positive more."
            : ""}
          {anyDirect
            ? " The shaded rows are companies you hold directly, as a stock, rather" +
              " than only through a fund."
            : ""}
          {anyCountry
            ? " The flag and two-letter code beside a company are the domicile its" +
              " holders' filings agree on by value. The row's left edge repeats it in colour — blue for" +
              " the United States, ochre for developed markets elsewhere, a deeper" +
              " ochre for emerging ones. A grey edge marks a company with no market" +
              " tier: solid where the domicile is known but is neither developed nor" +
              " emerging, dashed where the filings do not agree on a country at all." +
              // Only when there is a bracket to colour: the column is absent without a
              // benchmark, and a sentence about an ink with nothing wearing it is noise.
              (benchmark
                ? " The bracketed difference in the In " +
                  benchmark.ticker +
                  " column is green when you hold more of the company than " +
                  benchmark.ticker +
                  " does and red when you hold less; an exact match is left plain."
                : "") +
              " Developed and emerging follow the FTSE country classification, as of " +
              TIER_AS_OF +
              "."
            : ""}
        </caption>
        <thead>
          <tr>
            <th scope="col" aria-sort={ariaSort("name")}>
              <button
                type="button"
                className="sort-button"
                onClick={() => toggle("name")}
              >
                Company
              </button>
            </th>
            <th scope="col" className="numeric" aria-sort={ariaSort("weight")}>
              <button
                type="button"
                className="sort-button"
                onClick={() => toggle("weight")}
              >
                Portfolio weight
              </button>
            </th>
            {benchmark ? (
              <th scope="col" className="numeric" aria-sort={ariaSort("benchmark")}>
                <button
                  type="button"
                  className="sort-button"
                  onClick={() => toggle("benchmark")}
                >
                  In {benchmark.ticker}
                </button>
              </th>
            ) : null}
            <th scope="col" className="numeric" aria-sort={ariaSort("holder_count")}>
              <button
                type="button"
                className="sort-button"
                onClick={() => toggle("holder_count")}
              >
                Funds
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => {
            const benchmarkWeight = row.benchmark_weight;
            const delta = benchmarkDelta(row.weight, benchmarkWeight);
            // The two axes, side by side and independent: `data-direct` makes the row's
            // background mean position kind, and `data-tier` makes a 6px edge on the
            // first cell mean geography — American, developed ex-US, emerging, or a
            // domicile in neither list — under the convention `lib/country-tier.ts`
            // records. A row can carry both; neither borrows the other's encoding.
            // `data-country` keeps the raw code in the DOM so the edge can be traced back
            // to the domicile that produced it. A row the release could not place carries
            // no `data-tier` and `data-country-missing` instead, which is what draws the
            // dashed neutral edge: the operator's report was that such a row looked
            // colourless rather than unplaced, so absence gets a mark of its own.
            return (
              <tr
                key={row.company_id}
                data-direct={row.held_directly ? "true" : undefined}
                data-country={row.country ?? undefined}
                data-tier={row.country ? tierOf(row.country) : undefined}
                data-country-missing={row.country ? undefined : "true"}
              >
                <th scope="row">
                  {onSelect ? (
                    <button
                      type="button"
                      className="row-button"
                      onClick={() => onSelect(row)}
                    >
                      {row.name}
                    </button>
                  ) : (
                    row.name
                  )}
                  {/* Every fund, never a "+N more": an attribution a reader has to
                    expand a tooltip to see is an attribution the row does not show
                    (static-xray-frontend §6, "no meaning behind hover"). The chips
                    wrap, so a 12-fund portfolio grows the row rather than clipping
                    it. */}
                  <span className="row-note">
                    {row.ticker ? `${row.ticker} · ` : ""}
                    <span className="fund-attrib">
                      {row.sources.map((source) => (
                        <span
                          className="fund-attrib__item"
                          key={`${source.kind}-${source.ref}`}
                        >
                          <span className="fund-attrib__ticker">
                            {source.kind === "security"
                              ? `You · ${source.ref}`
                              : source.ref}
                          </span>{" "}
                          <span className="fund-attrib__weight">
                            {formatShare(source.weight)}
                          </span>
                        </span>
                      ))}
                    </span>
                    {/* The mark is the country's flag beside its two-letter code. The
                      flag is *derived* from that code — the two letters become regional
                      indicators, and the platform's emoji font decides what that looks
                      like: macOS, iOS and Android draw a flag, Windows' Segoe UI Emoji
                      has no flag glyphs and draws the two boxed letters, so a Windows
                      tag reads "US US". Both are printed (operator's choice, 2026-11-02:
                      show the flag and the code, "even with the awkward screen reader
                      behavior"), so the flag is decoration and the code is the fact: the
                      glyph is `aria-hidden` and a screen reader hears the code, exactly
                      as it did before the flag existed. No tooltip — a meaning that lives
                      behind hover is a meaning half the readers never get. A company the
                      filings do not agree on renders nothing here: no mark is the honest
                      answer, and a default would be a guess. */}
                    {row.country ? (
                      <>
                        {" "}
                        <span className="country-tag">
                          <span aria-hidden="true">{flagEmoji(row.country)}</span>{" "}
                          {row.country}
                        </span>
                      </>
                    ) : null}
                  </span>
                </th>
                <td className="numeric">{formatShare(row.weight)}</td>
                {benchmark ? (
                  <td className="numeric">
                    {/* Your weight minus the benchmark's, in percentage points. The
                      sign is rendered, never implied, and the caption says which way
                      round it is — a bracket with no stated direction is a number a
                      reader has to guess at (`static-xray-frontend` §4a, ADR-0015
                      amendment 2026-11-02). `delta === null` is a missing benchmark
                      value, not a zero (`static-xray-frontend` §6). */}
                    {benchmarkWeight === null || delta === null ? (
                      "—"
                    ) : (
                      <>
                        {formatShare(benchmarkWeight)}{" "}
                        {/* The bracket wears the row's geography ink — blue for a US
                          company, ochre for an international one — repeating the edge at
                          the one cell where two numbers are compared (operator's
                          instruction, 2026-11-02). The class carries no meaning of its
                          own: the stylesheet keys it off `data-country` on the row, the
                          sign is in the text, and the direction is a sentence in the
                          caption (`static-xray-frontend` §4a, §8). */}
                        <span className={deltaInkClass(delta)}>
                          {formatSignedShare(delta)}
                        </span>
                      </>
                    )}
                  </td>
                ) : null}
                <td className="numeric">
                  {row.holder_count === 0 && row.held_directly ? (
                    // A company you own outright is not held by any fund, and "0"
                    // beside it would read as an error rather than as the fact.
                    <span className="muted">direct</span>
                  ) : (
                    row.holder_count
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
