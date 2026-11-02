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

import { formatCount, formatShare } from "@/lib/format";
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
              "'s own portfolio — the benchmark's holding, not yours."
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
          {visible.map((row) => (
            <tr key={row.company_id}>
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
                </span>
              </th>
              <td className="numeric">{formatShare(row.weight)}</td>
              {benchmark ? (
                <td className="numeric">
                  {row.benchmark_weight === null
                    ? // No value is not a zero: a missing number prints as missing
                      // (`static-xray-frontend` §6), and this cell is only reachable
                      // if the ledger and the table disagree about having a benchmark.
                      "—"
                    : formatShare(row.benchmark_weight)}
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
          ))}
        </tbody>
      </table>
    </div>
  );
}
