"use client";

/**
 * `/c/`: the reverse X-Ray — who holds this company, and how much of each fund.
 *
 * This is the page the ledger cannot be: the ledger starts from a portfolio and
 * ends at companies, this starts from a company and ends at funds. Both read the
 * same release, and the company shard is built from the fund documents rather than
 * maintained beside them, so the two directions cannot disagree.
 *
 * The search is client-side over `companies/index.json` (5,179 rows, 106 KB
 * gzipped): the app is a static export, so there is no endpoint to query and no
 * request to log. Selecting a company writes its id to the fragment, which makes a
 * company page a link you can send.
 */

import { useEffect, useMemo, useState } from "react";

import { Notice } from "@/components/Notice";
import { formatCount, formatShare } from "@/lib/format";
import type { CompanyIndexRow } from "@/lib/types";
import { useCompany, useCompanyIndex, useRelease } from "@/lib/use-release";

/** Matches rendered before the list asks to be told to render more. */
const ROW_PAGE = 50;

function useSelectedCompany(): [string | null, (id: string | null) => void] {
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const read = () => {
      const raw = window.location.hash.replace(/^#/, "").trim();
      setSelected(/^c_\d{10}$/.test(raw) ? raw : null);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  function select(id: string | null) {
    const url =
      id === null
        ? `${window.location.pathname}${window.location.search}`
        : `${window.location.pathname}${window.location.search}#${id}`;
    window.history.pushState(null, "", url);
    setSelected(id);
  }

  return [selected, select];
}

function matches(rows: CompanyIndexRow[], query: string): CompanyIndexRow[] {
  const needle = query.trim().toUpperCase();
  if (!needle) return [];
  const exact: CompanyIndexRow[] = [];
  const prefix: CompanyIndexRow[] = [];
  const contains: CompanyIndexRow[] = [];
  for (const row of rows) {
    const [, name, ticker] = row;
    if (ticker && ticker === needle) exact.push(row);
    else if (name.toUpperCase().startsWith(needle) || (ticker ?? "").startsWith(needle))
      prefix.push(row);
    else if (name.toUpperCase().includes(needle)) contains.push(row);
    if (prefix.length + exact.length >= ROW_PAGE * 4) break;
  }
  return [...exact, ...prefix, ...contains].slice(0, ROW_PAGE * 4);
}

export function CompanyView() {
  const release = useRelease();
  const index = useCompanyIndex(release.status === "ready" ? release.data : null);
  const [selected, select] = useSelectedCompany();
  const company = useCompany(release.status === "ready" ? release.data : null, selected);
  const [query, setQuery] = useState("");

  const results = useMemo(
    () => (index.status === "ready" ? matches(index.data.companies, query) : []),
    [index, query],
  );

  // A company linked in the URL has no name until its shard arrives; the heading
  // waits for the shard rather than showing a raw id to the visitor.
  const heading =
    company.status === "ready"
      ? company.data.name
      : selected
        ? selected
        : "Who holds this company";

  return (
    <>
      <h1>{heading}</h1>
      <p className="prose">
        Search for a company to see every fund in the published release that holds it, and
        how much of each fund it is. This is the same data as the{" "}
        <a href="/x/">look-through ledger</a>, read in the other direction.
      </p>

      {release.status === "error" ? (
        <Notice tone="error" title={release.error.message} detail={release.error.detail}>
          <p>Nothing was read, so there is nothing to search.</p>
        </Notice>
      ) : null}

      <form
        className="field"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          const first = results[0];
          if (first) select(first[0]);
        }}
      >
        <label htmlFor="company-search" className="sr-only">
          Company name or ticker
        </label>
        <input
          id="company-search"
          type="search"
          autoComplete="off"
          spellCheck={false}
          placeholder={
            index.status === "ready"
              ? `Company or ticker, e.g. ${index.data.companies[0]?.[2] ?? "NVDA"}`
              : "Company or ticker"
          }
          value={query}
          aria-describedby="company-search-hint"
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" className="primary">
          Search
        </button>
      </form>
      <p id="company-search-hint" className="muted" style={{ fontSize: "0.85rem" }}>
        {index.status === "ready"
          ? `${formatCount(index.data.companies.length)} companies in release ${index.data.as_of}.`
          : index.status === "error"
            ? index.error.message
            : "Reading the company index…"}
      </p>

      {selected ? (
        <p>
          <button type="button" onClick={() => select(null)}>
            Clear
          </button>
        </p>
      ) : null}

      {company.status === "error" ? (
        <Notice
          tone="error"
          title={company.error.message}
          detail={company.error.detail}
        />
      ) : null}

      {selected && company.status !== "ready" ? (
        <p className="muted" role="status">
          Reading {selected}…
        </p>
      ) : null}

      {company.status === "ready" ? (
        <>
          <p className="muted">
            {formatCount(company.data.funds.length)}{" "}
            {company.data.funds.length === 1 ? "fund holds" : "funds hold"} this company,
            largest position first. Weights are shares of each fund, not of any portfolio.
          </p>
          <div className="table-wrap">
            <table className="ledger">
              <caption>
                Funds in release {company.data.as_of} holding {company.data.name}
                {company.data.ticker ? ` (${company.data.ticker})` : ""}.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Fund</th>
                  <th scope="col" className="numeric">
                    Share of the fund
                  </th>
                </tr>
              </thead>
              <tbody>
                {company.data.funds.map(([ticker, weightBp]) => (
                  <tr key={ticker}>
                    <th scope="row">{ticker}</th>
                    <td className="numeric">{formatShare(weightBp / 10_000)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {query.trim() && !selected ? (
        results.length === 0 ? (
          <p className="muted" role="status">
            No company in this release matches “{query.trim()}”.
          </p>
        ) : (
          <>
            <h2>Matches</h2>
            <ul className="portfolio-list">
              {results.map((row) => (
                <li key={row[0]}>
                  <button
                    type="button"
                    className="row-button"
                    onClick={() => select(row[0])}
                  >
                    {row[1]}
                  </button>
                  <span className="row-note">
                    {row[2] ? `${row[2]} · ` : ""}
                    held by {formatCount(row[3])} {row[3] === 1 ? "fund" : "funds"}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}
    </>
  );
}
