"use client";

/**
 * `/c/` — every company that appears in a fund filing, in one table.
 *
 * The directory answers "who is this, and does a fund hold it": name, ticker,
 * domicile, and how many funds in the release report it. It deliberately does not
 * answer "should I own it": there is no score, no return, no size, and the only
 * ordering is the reader's own — a column they clicked, or the closest match to
 * what they typed.
 *
 * Pagination at 50 rows rather than virtualization, for the same reason as the fund
 * directory: 12,895 rows is a document, not a table, and a literal `<table>` with a
 * caption and scoped headers is worth more than the milliseconds virtualization
 * saves. The whole index is in memory; a page change is a slice.
 */

import { useMemo, useState } from "react";

import { flagEmoji } from "@/lib/country-flag";
import { tierOf } from "@/lib/country-tier";

import { useProvider } from "@/components/lenses/provider-preference";
import { formatCount } from "@/lib/format";
import type { ReleaseDescriptor } from "@/lib/types";

import { Provenance } from "../directory/Provenance";
import { pageOf, PAGE_SIZE } from "../directory/paging";
import styles from "./company.module.css";
import {
  COMPANY_COLUMN_LABELS,
  companyAriaSort,
  companyOrderDescription,
  DEFAULT_COMPANY_ORDER,
  nextCompanyOrder,
  orderCompanyRows,
  searchCompanyRows,
  type CompanyOrder,
  type CompanyOrderKey,
  type CompanyRow,
} from "./company-rows";

export interface CompaniesDirectoryProps {
  rows: CompanyRow[];
  status: "loading" | "ready" | "error";
  error: { message: string; detail: string } | null;
  release: ReleaseDescriptor | null;
  /** Opens a company's detail. The surface owns this, because it owns the fragment. */
  onOpen: (companyId: string) => void;
}

const COLUMNS: CompanyOrderKey[] = ["name", "ticker", "country", "holders"];

export function CompaniesDirectory({
  rows,
  status,
  error,
  release,
  onOpen,
}: CompaniesDirectoryProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<CompanyOrder | null>(null);
  const [page, setPage] = useState(1);
  // The row's edge is a tier, and a tier is a convention: the same one the Markets
  // lens shows, read from the URL.
  const { provider } = useProvider();

  const searching = query.trim().length > 0;

  // Until the reader picks an order, the page answers the question they asked: a
  // search is in match order, a browse is alphabetical. An explicit order wins and
  // keeps winning — that is what a clicked header means.
  const order = useMemo<CompanyOrder>(
    () => sort ?? (searching ? { key: "match" } : DEFAULT_COMPANY_ORDER),
    [sort, searching],
  );

  const filtered = useMemo(() => searchCompanyRows(rows, query), [rows, query]);
  const ordered = useMemo(
    () => (order.key === "match" ? filtered : orderCompanyRows(filtered, order)),
    [filtered, order],
  );
  const current = pageOf(ordered, page, PAGE_SIZE);

  const selectValue = order.key === "match" ? "match" : `${order.key}:${order.direction}`;

  function chooseOrder(value: string) {
    if (value === "match") {
      setSort({ key: "match" });
    } else {
      const [key, direction] = value.split(":");
      setSort({
        key: key as CompanyOrderKey,
        direction: direction === "descending" ? "descending" : "ascending",
      });
    }
    setPage(1);
  }

  return (
    <div className="stack stack--loose">
      <header className="stack">
        <p className="eyebrow">Directory</p>
        <h1 className="title">Companies</h1>
        <p className="lede">
          Every company that appears in a fund filing, with the domicile the release
          records and how many funds hold it. Pick one to see the funds behind it.
        </p>
        {release ? (
          <Provenance release={release}>
            {formatCount(release.company_count)} companies, tied to the companies of{" "}
            {formatCount(release.fund_count)} funds.
          </Provenance>
        ) : null}
      </header>

      {status === "error" && error ? (
        <div className="notice notice--alert" role="alert">
          <span className="notice__icon" aria-hidden="true">
            !
          </span>
          <div>
            <p>
              <strong>{error.message}</strong>
            </p>
            <p className="small">{error.detail}</p>
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

      {status === "loading" ? (
        <p className="notice" role="status">
          <span className="notice__icon" aria-hidden="true">
            ·
          </span>
          Reading the company index…
        </p>
      ) : null}

      {status === "ready" ? (
        <>
          <section aria-labelledby="companies-filters" className="stack">
            <h2 id="companies-filters" className="visually-hidden">
              Find a company
            </h2>
            <div className={styles.controls}>
              <div className="field">
                <label className="field__label" htmlFor="companies-search">
                  Search
                </label>
                <input
                  id="companies-search"
                  type="search"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Apple, AAPL, c_0000320193"
                  value={query}
                  onChange={(event) => {
                    const next = event.target.value;
                    setQuery(next);
                    setPage(1);
                    // An empty box has no matches to rank: fall back to the
                    // alphabetical default rather than leaving the list unsorted.
                    if (next.trim().length === 0 && sort?.key === "match") {
                      setSort(null);
                    }
                  }}
                />
                <p className="field__hint">
                  Name, ticker, or company id — several words are all required.
                </p>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="companies-order">
                  Order
                </label>
                <select
                  id="companies-order"
                  value={selectValue}
                  onChange={(event) => chooseOrder(event.target.value)}
                >
                  {searching ? <option value="match">Closest match</option> : null}
                  <option value="name:ascending">Company name, A–Z</option>
                  <option value="name:descending">Company name, Z–A</option>
                  <option value="holders:descending">Most funds first</option>
                  <option value="holders:ascending">Fewest funds first</option>
                  <option value="ticker:ascending">Ticker, A–Z</option>
                  <option value="ticker:descending">Ticker, Z–A</option>
                  <option value="country:ascending">Domicile, A–Z</option>
                </select>
              </div>
            </div>
          </section>

          {filtered.length === 0 ? (
            <div className="empty">
              <p className="empty__title">No company matches</p>
              <p className="small muted">
                Nothing matches “{query.trim()}”. The index lists every company any fund
                in the release reports, so a miss here is a typo or a company no fund
                holds — not a gap in the data.
              </p>
              <p className="row">
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  onClick={() => {
                    setQuery("");
                    setSort(null);
                    setPage(1);
                  }}
                >
                  Clear search
                </button>
              </p>
            </div>
          ) : (
            <div className="stack">
              <div className="table-wrap">
                <table className="table">
                  <caption>
                    {formatCount(filtered.length)}{" "}
                    {filtered.length === 1 ? "company" : "companies"}, ordered{" "}
                    {companyOrderDescription(order)}. Rows {formatCount(current.start)}–
                    {formatCount(current.end)} of {formatCount(filtered.length)}.
                    &ldquo;Held by&rdquo; counts the funds in this release that report the
                    company; it is not a size or a popularity measure, and a blank
                    domicile means the release has no answer rather than a default.
                  </caption>
                  <thead>
                    <tr>
                      {COLUMNS.map((key) => (
                        <th
                          key={key}
                          scope="col"
                          aria-sort={companyAriaSort(order, key)}
                          className={key === "holders" ? "num" : undefined}
                        >
                          <button
                            type="button"
                            className="table__sort"
                            onClick={() => {
                              setSort(nextCompanyOrder(order, key));
                              setPage(1);
                            }}
                          >
                            {COMPANY_COLUMN_LABELS[key]}
                            {/* The arrow is drawn by `th[aria-sort] .table__sort::after`
                             * in globals.css, so it cannot disagree with the header. */}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {current.rows.map((row) => (
                      <tr
                        key={row.id}
                        data-tier={
                          row.country ? tierOf(row.country, { provider }) : undefined
                        }
                        data-country-missing={row.country ? undefined : "true"}
                      >
                        <th scope="row">
                          {/* The href is the whole answer without JavaScript; with it,
                              the click goes through the fragment store so the company
                              is added to the URL instead of replacing everything in it. */}
                          <a
                            href={`/c/#${row.id}`}
                            onClick={(event) => {
                              if (
                                event.metaKey ||
                                event.ctrlKey ||
                                event.shiftKey ||
                                event.altKey
                              ) {
                                return;
                              }
                              event.preventDefault();
                              onOpen(row.id);
                            }}
                          >
                            {row.name}
                          </a>
                        </th>
                        <td className="mono">{row.ticker ?? "—"}</td>
                        <td>
                          {row.country ? (
                            <span className="country-tag">
                              <span aria-hidden="true">{flagEmoji(row.country)}</span>{" "}
                              {row.country}
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td className="num">{formatCount(row.holders)}</td>
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
