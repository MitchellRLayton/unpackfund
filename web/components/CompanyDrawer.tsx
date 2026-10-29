"use client";

/**
 * One company, from the other direction: which funds hold it, and how much of each.
 *
 * This is the reverse X-Ray. The ledger answers "what do I own?" and this answers
 * "who owns this?" — the same shard read the other way round, which is why the
 * index is built from the fund documents rather than maintained separately: the two
 * views cannot disagree.
 *
 * The two weight columns are different quantities and are labelled as such. "Share
 * of the fund" is the holding's weight inside that fund, straight from the filing.
 * "Of your portfolio" is that weight times the fund's share of the portfolio — the
 * number the ledger already showed. Multiplying one by the other is the only place
 * they mix, and it happens once, in the aggregation.
 *
 * A native `<dialog>` rather than a div: the browser gives focus trapping, Escape,
 * the backdrop, and an inert page behind it, none of which is worth re-implementing
 * badly.
 */

import { useEffect, useRef } from "react";

import { formatCount, formatShare } from "@/lib/format";
import type { CompanyShard, LedgerRow, ReleaseDescriptor } from "@/lib/types";
import { useCompany } from "@/lib/use-release";

export function CompanyDrawer({
  release,
  row,
  onClose,
}: {
  release: ReleaseDescriptor | null;
  row: LedgerRow | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const company = useCompany(release, row?.company_id ?? null);
  const open = row !== null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const portfolioWeight = new Map(
    (row?.sources ?? []).map((source) => [source.ticker, source.weight]),
  );

  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-labelledby="company-drawer-title"
      onClose={onClose}
      // A click on the dialog element itself is a click on the backdrop: the
      // content is inside a child, so the event only reaches here through the gap.
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      {row ? (
        <div className="drawer__body">
          <header className="drawer__head">
            <h2 id="company-drawer-title">
              {row.name}
              {row.ticker ? <span className="drawer__ticker">{row.ticker}</span> : null}
            </h2>
            <button type="button" className="drawer__close" onClick={onClose}>
              Close
            </button>
          </header>

          <p className="muted">
            {formatShare(row.weight)} of your portfolio, across {row.fund_count}{" "}
            {row.fund_count === 1 ? "fund" : "funds"}.
          </p>

          {company.status === "error" ? (
            <p className="notice notice--error" role="alert">
              {company.error.message}
              <span className="row-note">{company.error.detail}</span>
            </p>
          ) : null}

          {company.status !== "ready" ? (
            <p className="muted" role="status">
              Reading the release&apos;s company index…
            </p>
          ) : (
            <>
              <div className="table-wrap">
                <table className="ledger">
                  <caption>
                    Every fund in release {company.data.as_of} that holds this company,
                    largest position first.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Fund</th>
                      <th scope="col" className="numeric">
                        Share of the fund
                      </th>
                      <th scope="col" className="numeric">
                        Of your portfolio
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {company.data.funds.map(([ticker, weightBp]) => (
                      <tr key={ticker}>
                        <th scope="row">{ticker}</th>
                        <td className="numeric">{formatShare(weightBp / 10_000)}</td>
                        <td className="numeric">
                          {portfolioWeight.has(ticker) ? (
                            formatShare(portfolioWeight.get(ticker) ?? 0)
                          ) : (
                            <span className="muted">not held</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted drawer__note">
                {formatCount(company.data.funds.length)}{" "}
                {company.data.funds.length === 1 ? "fund holds" : "funds hold"} this
                company in the published release. The ledger lists only the funds in your
                own portfolio, which is why this table can be longer than the one behind
                it.
              </p>
            </>
          )}
        </div>
      ) : null}
    </dialog>
  );
}

/** The company shard, for a caller that wants to render it outside a drawer. */
export type { CompanyShard };
