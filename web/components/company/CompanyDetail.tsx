"use client";

/**
 * The company detail, as a modal over the directory, driven by `#c_<company_id>`.
 *
 * Three release objects answer three different questions, and the order they are
 * asked in is the order a reader asks them:
 *
 * 1. **Who is this?** — the index row, already in memory from the directory, so
 *    the heading is right on the first frame instead of a skeleton.
 * 2. **Which funds hold it?** — `companies/{id}.json`, whose `funds` array is the
 *    company's weight *in each fund*, largest first. That is the only comparison
 *    those numbers support, so it is the only order the table offers.
 * 3. **How much of it do I own?** — this is the question the portfolio fragment
 *    answers, and it is answered from the ledger the workspace already built, in
 *    one row lookup. No second look-through is computed here: `lookthrough-math-and-qa`
 *    §5 has one implementation of a portfolio's company weights, and this reads it.
 *    With no portfolio in the URL the sentence is absent rather than zero.
 *
 * The dialog is a native `<dialog>` opened with `showModal()`: the browser owns the
 * focus trap, the inert background, Escape, and the `::backdrop`, and the `close`
 * event is the single path that clears the fragment — so Escape, the Close button,
 * a backdrop click and the Back button all end in the same state.
 *
 * The workspace arrives as props rather than as a second `useWorkspace()` call: the
 * surface already holds the one instance, and a second would build the look-through
 * ledger twice for one page.
 */

import { useEffect, useRef } from "react";

import { flagEmoji } from "@/lib/country-flag";
import { PROVIDER_NAMES, tierOf } from "@/lib/country-tier";
import { formatCount, formatShare, formatWeightBp } from "@/lib/format";
import { isCompanyId, type Ledger, type ReleaseDescriptor } from "@/lib/types";
import { useCatalogue, useCompany } from "@/lib/use-release";

import { useProvider } from "@/components/lenses/provider-preference";

import styles from "./company.module.css";
import {
  companyCountry,
  companyFundRows,
  holdingLine,
  tierLabel,
  type CompanyRow,
} from "./company-rows";

/** A company can be held by thousands of funds; the dialog lists the biggest positions. */
const FUND_ROW_LIMIT = 50;

export interface CompanyDetailProps {
  rows: CompanyRow[];
  release: ReleaseDescriptor | null;
  /** The fragment's company id, or `null`. */
  companyId: string | null;
  /** The workspace's look-through, for the "you hold" line. */
  ledger: Ledger | null;
  countryOf: (companyId: string) => string | null;
  /** Writes the company into the fragment, or clears it with `null`. */
  openCompany: (companyId: string | null) => void;
}

export function CompanyDetail({
  rows,
  release,
  companyId: rawId,
  ledger,
  countryOf,
  openCompany,
}: CompanyDetailProps) {
  const companyId = rawId !== null && isCompanyId(rawId) ? rawId : null;
  // The same convention the Markets lens shows: one choice, read from the URL.
  const { provider } = useProvider();

  const shard = useCompany(release, companyId);
  // The catalogue is only read once a company is open, and only for the fund names
  // on its table; without it the table still works, with tickers as its labels.
  const catalogue = useCatalogue(companyId ? release : null);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    if (companyId && !node.open) {
      const active = document.activeElement;
      returnTo.current = active instanceof HTMLElement ? active : null;
      node.showModal();
      // Focus the company's name, not the Close button: the first thing a screen
      // reader should hear is which company this is.
      requestAnimationFrame(() => headingRef.current?.focus());
    } else if (!companyId && node.open) {
      node.close();
    }
  }, [companyId]);

  // Focus goes back to the row that opened the dialog, once that row is on screen.
  useEffect(() => {
    if (companyId !== null) return;
    const target = returnTo.current;
    returnTo.current = null;
    target?.focus();
  }, [companyId]);

  const row = companyId ? (rows.find((entry) => entry.id === companyId) ?? null) : null;
  const name = shard.data?.name ?? row?.name ?? "Company";
  const ticker = shard.data?.ticker ?? row?.ticker ?? null;
  const country = companyId
    ? (companyCountry(shard.data, companyId, null) ?? countryOf(companyId))
    : null;
  const holding = companyId ? holdingLine(ledger, companyId) : null;
  const funds = companyFundRows(shard.data, catalogue.data);
  const shown = funds.slice(0, FUND_ROW_LIMIT);

  return (
    <dialog
      ref={dialogRef}
      className={`search-dialog ${styles.dialog}`}
      aria-labelledby={companyId ? "company-detail-title" : undefined}
      aria-label={companyId ? undefined : "Company detail"}
      onClose={() => {
        if (companyId) openCompany(null);
      }}
      onClick={(event) => {
        // A click on the backdrop (the dialog element itself) closes it.
        if (event.target === dialogRef.current) dialogRef.current?.close();
      }}
    >
      {companyId ? (
        <>
          <div className={styles.detailHead}>
            <p className="eyebrow">Company</p>
            <h2
              id="company-detail-title"
              ref={headingRef}
              tabIndex={-1}
              className={`title title--sm ${styles.detailTitle}`}
            >
              {name}
            </h2>
            <p className="row small muted">
              {ticker ? <span className="chip chip--mono">{ticker}</span> : null}
              <span className="mono">{companyId}</span>
            </p>
            <p className="row">
              <button
                type="button"
                className="btn btn--quiet btn--sm"
                onClick={() => dialogRef.current?.close()}
              >
                Close
              </button>
            </p>
          </div>

          <div className={styles.detailBody}>
            <div className="stack">
              <div className={styles.facts}>
                <div className={styles.fact}>
                  <span className={styles.fact__label}>Domicile</span>
                  <span className={styles.fact__value}>
                    {country ? (
                      <span className="country-tag">
                        <span aria-hidden="true">{flagEmoji(country)}</span> {country}
                      </span>
                    ) : (
                      <span className="muted">not recorded</span>
                    )}
                  </span>
                </div>
                <div className={styles.fact}>
                  <span className={styles.fact__label}>Held by</span>
                  <span className={styles.fact__value}>
                    {shard.status === "ready"
                      ? `${formatCount(funds.length)} ${funds.length === 1 ? "fund" : "funds"}`
                      : "…"}
                  </span>
                </div>
                {holding ? (
                  <div className={styles.fact}>
                    <span className={styles.fact__label}>Your holding</span>
                    <span className={styles.fact__value}>
                      {formatShare(holding.weight)}
                    </span>
                  </div>
                ) : null}
              </div>

              {country && tierLabel(tierOf(country, { provider }), provider) ? (
                <p className="small muted">
                  The tier comes from the release&apos;s {PROVIDER_NAMES[provider]}{" "}
                  country classification:{" "}
                  {tierLabel(tierOf(country, { provider }), provider)}.
                </p>
              ) : null}

              {holding ? (
                <p className="answer__note">
                  You hold <strong>{formatShare(holding.weight)}</strong> of this company
                  through {formatCount(holding.funds)}{" "}
                  {holding.funds === 1 ? "fund" : "funds"} in your portfolio.
                </p>
              ) : null}

              {shard.status === "error" ? (
                <div className="notice notice--alert" role="alert">
                  <span className="notice__icon" aria-hidden="true">
                    !
                  </span>
                  <div>
                    <p>
                      <strong>{shard.error.message}</strong>
                    </p>
                    <p className="small">{shard.error.detail}</p>
                  </div>
                </div>
              ) : null}

              {shard.status === "loading" ? (
                <p className="small muted" role="status">
                  Reading the funds that report this company…
                </p>
              ) : null}

              {shard.status === "ready" ? (
                <>
                  <div className="table-wrap">
                    <table className="table">
                      <caption>
                        The{" "}
                        {funds.length <= shown.length
                          ? `${formatCount(funds.length)} ${funds.length === 1 ? "fund" : "funds"}`
                          : `${formatCount(shown.length)} largest of the ${formatCount(funds.length)} funds`}{" "}
                        that report this company, ordered by how much of each fund it is.
                        The weight is the fund&apos;s own filed basis points for this
                        holding, so it says how much of that fund the company is — not how
                        much of the company the fund owns.
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Fund</th>
                          <th scope="col" className="num">
                            Weight in fund
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((fund) => (
                          <tr key={fund.ticker}>
                            <th scope="row">
                              {/* The fund's page is a generated static document. */}
                              <a href={`/f/${fund.ticker}/`}>{fund.name}</a>{" "}
                              {fund.name === fund.ticker ? null : (
                                <span className="mono tiny muted">{fund.ticker}</span>
                              )}
                            </th>
                            <td className="num">{formatWeightBp(fund.weightBp)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {funds.length > shown.length ? (
                    <p className="small muted">
                      Showing the {formatCount(shown.length)} largest positions.{" "}
                      <a href="/funds/">The fund directory</a> lists everything in the
                      release.
                    </p>
                  ) : null}

                  <p className="small muted">
                    A fund with low coverage contributes less to a look-through, and the
                    fund&apos;s own page says how much of its weight we can trace.
                  </p>
                </>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </dialog>
  );
}
