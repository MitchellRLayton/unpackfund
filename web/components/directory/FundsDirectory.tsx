"use client";

/**
 * `/funds/` — every fund in the release, in one table.
 *
 * The page opens on the order `lib/directory.ts` says this release supports
 * (largest funds first when the catalogue carries filed net assets, the editorial
 * order when it predates them), and says which it is in the caption. It is not a
 * ranking: no score, no return, no recommendation, and the only "best" on the
 * page is "best match for what you typed".
 *
 * A literal `<table>` with a caption, `scope` headers and `aria-sort`, paginated
 * at 50 rows rather than virtualized, because pagination keeps those semantics
 * real — a screen reader hears "row 3 of 50, column 2 of 4" instead of an
 * `aria-rowindex` we maintain by hand (`static-xray-frontend` §8). The whole
 * catalogue is in memory (the one object this page exists to read), so a page
 * change is a slice, not a fetch.
 *
 * Every row is a plain `<a>`, not `<Link>`: `/f/{TICKER}/` is a static document
 * the pipeline writes, not a Next route, so the navigation must be a full page
 * load — the client router has nothing to render there.
 */

import { useMemo, useState } from "react";

import { toRows } from "@/lib/directory";
import { coverageBand, coverageChip, formatCount } from "@/lib/format";
import { useCatalogue, useRelease } from "@/lib/use-release";

import { applyFilters, issuerOptions, type BandFilter } from "./directory-search";
import {
  ariaSortFor,
  COLUMN_LABELS,
  defaultOrder,
  nextOrder,
  orderDescription,
  orderRows,
  orderValue,
  type ColumnKey,
  type Order,
} from "./directory-order";
import { formatDollarsCompact } from "./money";
import { pageOf, PAGE_SIZE } from "./paging";
import { Provenance } from "./Provenance";
import styles from "./directory.module.css";

/** Most funds we can list before the table becomes a document of its own. */
const SEARCH_HINT = "Ticker, fund name, or issuer — several words are all required";

export function FundsDirectory() {
  const release = useRelease();
  const releaseData = release.status === "ready" ? release.data : null;
  const catalogue = useCatalogue(releaseData);

  const [query, setQuery] = useState("");
  const [issuer, setIssuer] = useState("");
  const [band, setBand] = useState<BandFilter>("all");
  const [chosen, setChosen] = useState<Order | null>(null);
  const [page, setPage] = useState(1);

  const rows = useMemo(
    () => (catalogue.status === "ready" ? toRows(catalogue.data.funds) : []),
    [catalogue],
  );
  const issuers = useMemo(() => issuerOptions(rows), [rows]);
  const searching = query.trim().length > 0;

  // Until the reader picks an order, the table answers the question they asked: a
  // search is in match order (the ladder's), a browse is in the release's order. A
  // column they clicked wins and keeps winning — that is what a header click is.
  const order = useMemo<Order>(
    () => chosen ?? (searching ? { kind: "search" } : defaultOrder(rows)),
    [chosen, searching, rows],
  );

  const filtered = useMemo(
    () => applyFilters(rows, { query, issuer: issuer.length > 0 ? issuer : null, band }),
    [rows, query, issuer, band],
  );
  const ordered = useMemo(() => orderRows(filtered, order), [filtered, order]);
  const current = pageOf(ordered, page, PAGE_SIZE);

  const busy = release.status === "loading" || catalogue.status === "loading";
  const failure =
    release.status === "error"
      ? release.error
      : catalogue.status === "error"
        ? catalogue.error
        : null;

  /** Every filter change returns to the first page: page 40 of a new result set is nowhere. */
  function resetPage() {
    setPage(1);
  }

  function chooseColumn(key: ColumnKey) {
    setChosen(nextOrder(order, key));
    resetPage();
  }

  return (
    <div className="stack stack--loose">
      <header className="stack">
        <p className="eyebrow">Directory</p>
        <h1 className="title">Funds</h1>
        <p className="lede">
          Every fund in the current release, with how much of its weight we can tie to a
          company you can then look through. Coverage is a property of the filing, not a
          score: below 60% a fund&apos;s concentration figures are withheld.
        </p>
        <h2 className="visually-hidden">Where this list comes from</h2>
        {releaseData ? (
          <Provenance release={releaseData}>
            {formatCount(releaseData.fund_count)} funds,{" "}
            {formatCount(releaseData.company_count)} companies.
          </Provenance>
        ) : null}
      </header>

      {failure ? (
        <div className="notice notice--alert" role="alert">
          <span className="notice__icon" aria-hidden="true">
            !
          </span>
          <div>
            <p>
              <strong>{failure.message}</strong>
            </p>
            <p className="small">{failure.detail}</p>
            <p className="small">
              <button
                type="button"
                className="btn btn--quiet btn--sm"
                onClick={() => window.location.reload()}
              >
                Try again
              </button>
            </p>
          </div>
        </div>
      ) : null}

      {busy && !failure ? (
        <p className="notice" role="status">
          <span className="notice__icon" aria-hidden="true">
            ·
          </span>
          Reading the fund catalogue…
        </p>
      ) : null}

      {catalogue.status === "ready" ? (
        <>
          <section aria-labelledby="funds-filters" className="stack">
            <h2 id="funds-filters" className="visually-hidden">
              Find a fund
            </h2>
            <div className={styles.controls}>
              <div className="field">
                <label className="field__label" htmlFor="funds-search">
                  Search
                </label>
                <input
                  id="funds-search"
                  type="search"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="VTI, Vanguard, total stock"
                  value={query}
                  onChange={(event) => {
                    const next = event.target.value;
                    setQuery(next);
                    setPage(1);
                    // An empty box has no matches to rank: fall back to the
                    // release's own order rather than leaving the table unsorted.
                    if (next.trim().length === 0 && chosen?.kind === "search") {
                      setChosen(null);
                    }
                  }}
                />
                <p className="field__hint">{SEARCH_HINT}</p>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="funds-issuer">
                  Issuer
                </label>
                <select
                  id="funds-issuer"
                  value={issuer}
                  onChange={(event) => {
                    setIssuer(event.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">All issuers</option>
                  {issuers.map((option) => (
                    <option key={option.issuer} value={option.issuer}>
                      {option.issuer} ({formatCount(option.count)})
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="funds-band">
                  Coverage
                </label>
                <select
                  id="funds-band"
                  value={band}
                  onChange={(event) => {
                    setBand(event.target.value as BandFilter);
                    setPage(1);
                  }}
                >
                  <option value="all">Any coverage</option>
                  <option value="full">Fully covered (70% and up)</option>
                  <option value="partial">Partly covered (60–70%)</option>
                  <option value="none">Not covered (under 60%)</option>
                </select>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="funds-order">
                  Order
                </label>
                <select
                  id="funds-order"
                  value={orderValue(order)}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "column") return;
                    setChosen(
                      value === "search"
                        ? { kind: "search" }
                        : { kind: value as "assets" | "popular" | "alpha" },
                    );
                    resetPage();
                  }}
                >
                  {searching ? <option value="search">Closest match</option> : null}
                  <option value="assets">Largest first</option>
                  <option value="popular">Widely held first</option>
                  <option value="alpha">A–Z by ticker</option>
                  {order.kind === "column" ? (
                    <option value="column">
                      {COLUMN_LABELS[order.key]} ({order.direction})
                    </option>
                  ) : null}
                </select>
              </div>
            </div>
          </section>

          {filtered.length === 0 ? (
            <div className="empty">
              <p className="empty__title">No fund matches</p>
              <p className="small muted">
                {query.trim().length > 0
                  ? `Nothing matches “${query.trim()}”`
                  : "Nothing matches these filters"}
                {issuer.length > 0 ? ` from ${issuer}` : ""}
                {band !== "all" ? ` in that coverage band` : ""}. The directory lists
                every fund in the current release, so an empty result is a typo or a fund
                that does not exist rather than a gap in the data.
              </p>
              <p className="row">
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  onClick={() => {
                    setQuery("");
                    setIssuer("");
                    setBand("all");
                    setChosen(null);
                    resetPage();
                  }}
                >
                  Clear filters
                </button>
              </p>
            </div>
          ) : (
            <div className="stack">
              <div className="table-wrap">
                <table className="table">
                  <caption>
                    {formatCount(filtered.length)}{" "}
                    {filtered.length === 1 ? "fund" : "funds"}, ordered{" "}
                    {orderDescription(order)}. Rows {formatCount(current.start)}–
                    {formatCount(current.end)} of {formatCount(filtered.length)}. Coverage
                    is the share of a fund&apos;s filed weight that maps to a company we
                    can identify, so a low figure is a limit of our mapping, not a defect
                    in the fund.
                  </caption>
                  <thead>
                    <tr>
                      {(
                        ["ticker", "name", "issuer", "assets", "coverage"] as ColumnKey[]
                      ).map((key) => (
                        <th
                          key={key}
                          scope="col"
                          aria-sort={ariaSortFor(order, key)}
                          className={
                            key === "coverage" || key === "assets" ? "num" : undefined
                          }
                        >
                          <button
                            type="button"
                            className="table__sort"
                            onClick={() => chooseColumn(key)}
                          >
                            {COLUMN_LABELS[key]}
                            {/* The arrow is drawn by `th[aria-sort] .table__sort::after`
                             * in globals.css, so it cannot disagree with the header. */}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {current.rows.map((row) => (
                      <tr key={row.ticker}>
                        <th scope="row" className="mono">
                          {/* A static document, so a full page load is the destination. */}
                          <a href={`/f/${row.ticker}/`}>{row.ticker}</a>
                        </th>
                        <td>
                          <a href={`/f/${row.ticker}/`}>{row.name}</a>
                        </td>
                        <td className="muted">{row.issuer}</td>
                        <td className="num">
                          {row.netAssets === null
                            ? "—"
                            : formatDollarsCompact(row.netAssets)}
                        </td>
                        <td className="num">
                          <span className={`chip chip--${coverageBand(row.coverage)}`}>
                            {coverageChip(row.coverage)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className={styles.pager}>
                <p className="small muted" role="status">
                  Showing rows {formatCount(current.start)}–{formatCount(current.end)} of{" "}
                  {formatCount(current.total)} · page {formatCount(current.page)} of{" "}
                  {formatCount(current.pages)}
                </p>
                <div className={styles.pager__buttons}>
                  <button
                    type="button"
                    className="btn btn--quiet btn--sm"
                    disabled={current.page <= 1}
                    onClick={() => setPage(current.page - 1)}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    className="btn btn--quiet btn--sm"
                    disabled={current.page >= current.pages}
                    onClick={() => setPage(current.page + 1)}
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
