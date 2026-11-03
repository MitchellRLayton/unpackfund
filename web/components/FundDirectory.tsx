"use client";

/**
 * `/funds/`: the directory behind the fund pages.
 *
 * The fund pages themselves are plain HTML written by the pipeline
 * (`python -m pipeline.fund_pages`) — one document per fund, no JavaScript, no
 * client fetch. This page is the only client-side piece: it reads the release's
 * `catalogue.json` once (8,983 rows, ~1 MB → ~180 kB gzipped) and filters it in
 * the browser, because a static export has no endpoint to query and the app
 * deliberately sends nothing about a visitor anywhere.
 *
 * It shows ticker, name, issuer and coverage — not the `etf` flag, which is a name
 * rule (`name_rule_v1`) that calls VOO a mutual fund, and which therefore is not
 * allowed to decide anything visible (ADR-0007 C3).
 *
 * The list opens on the **50 largest funds by assets**, where assets are the fund's
 * own filed N-PORT net assets — the release's fifth catalogue element, not a vendor
 * AUM figure (operator's instruction, 2026-11-02). Search still reaches every fund:
 * it filters all rows and only the *rendered* list is capped, because a reader
 * looking for a ticker must never be told "not in the release" by a page that is
 * showing the first 50 of them. When a release carries no figures at all — the live
 * `2026-11-02.7` predates the field — the order falls back to the editorial list and
 * the page says so instead of pretending to rank; see `lib/directory.ts` for the rule.
 */

import { useMemo, useState } from "react";

import { Notice } from "@/components/Notice";
import {
  defaultSort,
  type DirectorySort,
  filterRows,
  PARTIAL_COVERAGE,
  shownCoverage,
  sortRows,
  toRows,
} from "@/lib/directory";
import { formatCount } from "@/lib/format";
import { useCatalogue, useRelease } from "@/lib/use-release";

/** The default view's depth: the largest funds, without a search or a pager click. */
const TOP_BY_ASSETS = 50;

/** Rows added per click. The whole list is in memory; this only bounds the DOM. */
const ROW_PAGE = 100;

/** The orders the control offers, in the order it offers them. */
const SORTS: { value: DirectorySort; label: string }[] = [
  { value: "assets", label: "Assets" },
  { value: "popular", label: "Popular" },
  { value: "alpha", label: "A–Z" },
];

/** How the table caption names each order, so a sort is stated and not inferred. */
const ORDER_DESCRIPTIONS: Record<DirectorySort, string> = {
  assets: "largest by assets first",
  popular: "widely held first",
  alpha: "by ticker",
};

export function FundDirectory() {
  const release = useRelease();
  const catalogue = useCatalogue(release.status === "ready" ? release.data : null);
  const [query, setQuery] = useState("");
  // `null` means "whatever this release opens on". The default depends on the data
  // (assets when any row carries a figure, popular otherwise), so it cannot be a
  // fixed initial state: pinning one would make the fallback unreachable, and the
  // page would either open in ticker order or claim a ranking it has no figures for.
  const [sort, setSort] = useState<DirectorySort | null>(null);
  const [limit, setLimit] = useState(TOP_BY_ASSETS);

  const rows = useMemo(
    () => (catalogue.status === "ready" ? toRows(catalogue.data.funds) : []),
    [catalogue],
  );
  const effectiveSort = sort ?? defaultSort(rows);
  const hasAssets = useMemo(() => rows.some((row) => row.netAssets !== null), [rows]);
  const ordered = useMemo(() => sortRows(rows, effectiveSort), [rows, effectiveSort]);
  const matches = useMemo(() => filterRows(ordered, query), [ordered, query]);
  const visible = matches.slice(0, limit);

  function chooseSort(next: DirectorySort) {
    setSort(next);
    setLimit(TOP_BY_ASSETS);
  }

  return (
    <>
      <h1>Funds</h1>
      <p className="prose">
        Every fund in the published release, from its latest SEC N-PORT filing. Each fund
        has a page with its largest holdings, its concentration and how much of it we can
        map to a company. <a href="/x/">Look through a portfolio</a> instead if you want
        to see what a mix of funds owns.
      </p>

      {release.status === "error" ? (
        <Notice tone="error" title={release.error.message} detail={release.error.detail}>
          <p>Nothing was read, so there is nothing to list.</p>
        </Notice>
      ) : null}

      <form className="field" role="search" onSubmit={(event) => event.preventDefault()}>
        <label htmlFor="fund-search" className="sr-only">
          Fund ticker, name or issuer — separate words must all match
        </label>
        <input
          id="fund-search"
          type="search"
          autoComplete="off"
          spellCheck={false}
          placeholder={'Ticker, fund, issuer — or "avantis etf"'}
          value={query}
          aria-describedby="fund-search-hint"
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(TOP_BY_ASSETS);
          }}
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setLimit(TOP_BY_ASSETS);
            }}
          >
            Clear
          </button>
        ) : null}
      </form>
      <p id="fund-search-hint" className="muted" style={{ fontSize: "0.85rem" }}>
        {catalogue.status === "ready"
          ? `${formatCount(rows.length)} funds in release ${catalogue.data.as_of}.` +
            (query
              ? ` ${formatCount(matches.length)} match${matches.length === 1 ? "" : "es"}.`
              : "")
          : catalogue.status === "error"
            ? catalogue.error.message
            : "Reading the fund catalogue…"}
      </p>

      {catalogue.status === "error" ? (
        <Notice
          tone="error"
          title={catalogue.error.message}
          detail={catalogue.error.detail}
        />
      ) : null}

      {catalogue.status === "ready" && rows.length > 0 && !hasAssets ? (
        <Notice tone="info" title="This release carries no fund asset figures yet">
          <p>
            A fund&apos;s size is its own filed N-PORT net assets, and this release was
            built before the directory used them — so the list cannot open on the largest
            funds and falls back to our editorial order instead. The first release built
            with the figure opens on size, and the control below says which order is in
            effect either way.
          </p>
        </Notice>
      ) : null}

      {catalogue.status === "ready" && matches.length === 0 ? (
        <p className="muted" role="status">
          No fund matches “{query}”. Try a ticker, part of a fund or issuer name, or fewer
          words.
        </p>
      ) : null}

      {visible.length > 0 ? (
        <>
          <p className="muted" style={{ fontSize: "0.85rem", margin: "0.25rem 0" }}>
            {effectiveSort === "assets" && !query ? (
              <>
                The 50 largest by assets, from each fund&apos;s own N-PORT filing. Search
                for any of the {formatCount(Math.max(0, rows.length - visible.length))}{" "}
                other funds.{" "}
              </>
            ) : effectiveSort === "assets" ? (
              <>Largest by assets first. </>
            ) : effectiveSort === "popular" ? (
              <>
                Popular funds first — our pick of the widely held ones, not a size
                ranking.{" "}
              </>
            ) : (
              <>A–Z by ticker. </>
            )}
            <span role="group" aria-label="Order">
              {SORTS.map((option, index) => (
                <span key={option.value}>
                  {index > 0 ? " · " : null}
                  <button
                    type="button"
                    className="quiet"
                    aria-pressed={effectiveSort === option.value}
                    // A release with no figure at all cannot be ordered by size, so
                    // the option is offered but not selectable: enabling it would sort
                    // by ticker while the label still said "assets".
                    disabled={option.value === "assets" && !hasAssets}
                    title={
                      option.value === "assets" && !hasAssets
                        ? "This release carries no fund asset figures"
                        : undefined
                    }
                    onClick={() => chooseSort(option.value)}
                  >
                    {option.label}
                  </button>
                </span>
              ))}
            </span>
          </p>
          <p
            className="muted"
            style={{ fontSize: "0.85rem", margin: "0.25rem 0 0.5rem" }}
          >
            Coverage is the share of a fund&apos;s weight we can map to a company, so it
            says how complete that fund&apos;s page is. A dash means below{" "}
            {PARTIAL_COVERAGE}%, where a figure would describe our mapping rather than the
            fund.
          </p>
          <div className="table-wrap">
            <table className="ledger">
              <caption className="sr-only">
                {formatCount(matches.length)} {matches.length === 1 ? "fund" : "funds"} in
                release {catalogue.status === "ready" ? catalogue.data.as_of : ""},{" "}
                {ORDER_DESCRIPTIONS[effectiveSort]}.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Ticker</th>
                  <th scope="col">Fund</th>
                  <th scope="col" className="optional">
                    Issuer
                  </th>
                  <th scope="col" className="numeric">
                    Coverage
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.ticker}>
                    <th scope="row">
                      <a href={`/f/${row.ticker}/`}>{row.ticker}</a>
                    </th>
                    <td>
                      {row.name}
                      <span className="cell-note">{row.issuer}</span>
                    </td>
                    <td className="muted optional">{row.issuer}</td>
                    <td className="numeric">{shownCoverage(row.coverage) ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {limit < matches.length ? (
        <p>
          <button type="button" onClick={() => setLimit(limit + ROW_PAGE)}>
            Show {Math.min(ROW_PAGE, matches.length - limit)} more
          </button>
          <span className="muted" style={{ marginLeft: "0.75rem", fontSize: "0.85rem" }}>
            {formatCount(limit)} of {formatCount(matches.length)} shown
          </span>
        </p>
      ) : null}
    </>
  );
}
