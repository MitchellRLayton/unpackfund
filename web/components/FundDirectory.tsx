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
 * The list opens on the curated widely held funds (`popular.ts`) instead of A–Z,
 * which would lead with AAAA, AAAAX, AAAC. The order is editorial, not a size
 * ranking — the release carries no assets — and the line above the table says so.
 */

import { useMemo, useState } from "react";

import { Notice } from "@/components/Notice";
import {
  DEFAULT_SORT,
  type DirectorySort,
  filterRows,
  PARTIAL_COVERAGE,
  shownCoverage,
  sortRows,
  toRows,
} from "@/lib/directory";
import { formatCount } from "@/lib/format";
import { useCatalogue, useRelease } from "@/lib/use-release";

/** Rows per request. The whole list is in memory; this only bounds the DOM. */
const ROW_PAGE = 100;

export function FundDirectory() {
  const release = useRelease();
  const catalogue = useCatalogue(release.status === "ready" ? release.data : null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<DirectorySort>(DEFAULT_SORT);
  const [limit, setLimit] = useState(ROW_PAGE);

  const rows = useMemo(
    () => (catalogue.status === "ready" ? toRows(catalogue.data.funds) : []),
    [catalogue],
  );
  const ordered = useMemo(() => sortRows(rows, sort), [rows, sort]);
  const matches = useMemo(() => filterRows(ordered, query), [ordered, query]);
  const visible = matches.slice(0, limit);

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
            setLimit(ROW_PAGE);
          }}
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setLimit(ROW_PAGE);
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

      {catalogue.status === "ready" && matches.length === 0 ? (
        <p className="muted" role="status">
          No fund matches “{query}”. Try a ticker, part of a fund or issuer name, or fewer
          words.
        </p>
      ) : null}

      {visible.length > 0 ? (
        <>
          <p className="muted" style={{ fontSize: "0.85rem", margin: "0.25rem 0" }}>
            {sort === "popular" ? (
              <>
                Popular funds first — our pick of the widely held ones, not a size
                ranking.{" "}
                <button
                  type="button"
                  className="quiet"
                  onClick={() => {
                    setSort("alpha");
                    setLimit(ROW_PAGE);
                  }}
                >
                  A–Z instead
                </button>
              </>
            ) : (
              <>
                A–Z by ticker.{" "}
                <button
                  type="button"
                  className="quiet"
                  onClick={() => {
                    setSort("popular");
                    setLimit(ROW_PAGE);
                  }}
                >
                  Popular first
                </button>
              </>
            )}
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
                {sort === "popular" ? "widely held first" : "by ticker"}.
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
