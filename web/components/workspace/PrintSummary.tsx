"use client";

/**
 * The one-page summary that comes out of "Print summary".
 *
 * It exists because the printed page loses the two things that make the screen honest:
 * the footer's not-advice notice (the print stylesheet hides the site chrome) and the
 * answer strip's context. So this block carries both — the sentences, the coverage note,
 * the holdings with their reporting periods, the ten largest companies, and the same
 * not-advice sentence the footer uses, in the footer's words.
 *
 * It is `print-only`: `display: none` on screen and shown by the print rules, which is why
 * it duplicates numbers that are already on the page. That is deliberate — a reader who
 * prints gets one page that stands alone, and a screen reader is not offered a second copy
 * of the table it just read.
 *
 * The sentences come from `AnswerStrip`, the same component the screen uses, so a printed
 * summary cannot drift from the page it printed.
 */

import { AnswerStrip } from "./AnswerStrip";
import type { Answer } from "./answer";
import { coverageChip, formatCount, formatDateLong, formatShare } from "@/lib/format";
import type { WorkspaceModel } from "@/lib/use-workspace";

import styles from "./Workspace.module.css";

const TOP = 10;

export function PrintSummary({
  model,
  answer,
}: {
  model: WorkspaceModel;
  answer: Answer;
}) {
  if (model.portfolio.entries.length === 0) return null;
  const ledger = model.ledger;
  const asOf = model.releaseAsOf;
  const today = formatDateLong(new Date().toISOString().slice(0, 10));

  return (
    <section className="print-only stack stack--tight" aria-label="Printable summary">
      <header className={styles.printHead}>
        <div>
          <p className="eyebrow">UnpackFund</p>
          <h2 className="title--sm">Look-through summary</h2>
        </div>
        <p className="small">
          {asOf ? `Release ${asOf}` : "Release unknown"} · printed {today}
        </p>
      </header>

      <AnswerStrip answer={answer} />

      <section className="stack stack--tight">
        <h3 className="subtitle">Your holdings</h3>
        <ul className={styles.printList}>
          {model.portfolio.entries.map((entry) => {
            const label =
              entry.kind === "fund"
                ? (model.fundByTicker.get(entry.key)?.name ?? entry.key)
                : entry.kind === "security"
                  ? `${entry.key} (held directly)`
                  : "Cash";
            const fund = entry.kind === "fund" ? model.fundByTicker.get(entry.key) : null;
            return (
              <li key={`${entry.kind}:${entry.key}`}>
                <strong>{entry.key}</strong>{" "}
                {model.portfolio.mode === "bp"
                  ? formatShare(entry.amount / 10_000)
                  : `$${(entry.amount / 100).toFixed(2)}`}{" "}
                — {label}
                {fund
                  ? ` · ${coverageChip(fund.coverage_pct)}, reporting period ${formatDateLong(
                      fund.as_of,
                    )}, filed ${formatDateLong(fund.filed_at)}`
                  : ""}
              </li>
            );
          })}
        </ul>
      </section>

      {ledger && ledger.rows.length > 0 ? (
        <section className="stack stack--tight">
          <h3 className="subtitle">Ten largest companies</h3>
          <table className="table">
            <caption>
              The ten largest companies in this portfolio by weight, as one line each. The
              full table is on the site, and the CSV export holds every company.
            </caption>
            <thead>
              <tr>
                <th scope="col" className="num">
                  #
                </th>
                <th scope="col">Company</th>
                <th scope="col">Country</th>
                <th scope="col" className="num">
                  Weight
                </th>
                <th scope="col" className="num">
                  Funds
                </th>
              </tr>
            </thead>
            <tbody>
              {ledger.rows.slice(0, TOP).map((row, index) => (
                <tr key={row.company_id}>
                  <td className="num">{formatCount(index + 1)}</td>
                  <th scope="row">
                    {row.name}
                    {row.ticker ? (
                      <span className="mono small"> {row.ticker}</span>
                    ) : null}
                  </th>
                  <td>{row.country ?? "no code"}</td>
                  <td className="num">{formatShare(row.weight)}</td>
                  <td className="num">
                    {row.holder_count > 0 ? formatCount(row.holder_count) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <p className={styles.printFoot}>
        <strong>Not investment advice.</strong> UnpackFund shows what funds hold, from
        public SEC filings. It is not a recommendation to buy, hold or sell anything.
        Source: SEC EDGAR (Form N-PORT). Holdings data lags by 60 to 150 days and may be
        wrong. No SEC seal or logo is used, and the SEC has not reviewed or endorsed this
        site.
      </p>
    </section>
  );
}
