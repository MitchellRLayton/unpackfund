/**
 * The ledger as a CSV file.
 *
 * Why a client-side string and not an endpoint: the portfolio lives only in the URL
 * fragment (invariant I3), so a server that produced this file would have to receive
 * the portfolio first. The export therefore happens where the numbers already are —
 * in the page — and nothing leaves the browser.
 *
 * Two rules decide the columns:
 *
 * - **A number that leaves the page must carry what it came from.** Every row repeats
 *   `release_as_of`, because a spreadsheet outlives the page it was copied from and
 *   `12.05%` with no release is a number nobody can check (I6). `as_of` is the id the
 *   pointer publishes; there is no second identifier to disagree with it.
 * - **A direct holding is stated, not implied.** `held_directly` and the `sources`
 *   column say where each part of the weight came from (`VT 2.05%`, `You 10.00%`), so
 *   a reader of the file cannot mistake a fund's contribution for the visitor's.
 *
 * Rounding is the page's: two decimals, which is what every displayed weight uses.
 * A file with more precision than the page would invite a comparison the page cannot
 * support.
 */

import type { Ledger, LedgerSource } from "./types";

/** RFC 4180: quote when the value contains a delimiter, a quote, or a newline. */
function cell(value: string | number | boolean | null): string {
  const text = value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Basis points and fractions both become the same two-decimal percentage. */
function percent(fraction: number): string {
  return (fraction * 100).toFixed(2);
}

/** How a source is named in the file: `VT 2.05%` or `You 10.00%`. */
function describeSource(source: LedgerSource): string {
  const label = source.kind === "security" ? "You" : source.ref;
  return `${label} ${percent(source.weight)}%`;
}

export const CSV_COLUMNS = [
  "company_id",
  "name",
  "ticker",
  "portfolio_weight_pct",
  "held_directly",
  "fund_count",
  "sources",
  "release_as_of",
] as const;

/**
 * The whole ledger, sorted as it is displayed.
 *
 * `release` is the pair the page was rendered from rather than something read here:
 * the caller has already checked that the ledger and the release agree, and asking
 * for it again would be a second source of truth for the same fact.
 */
export function ledgerCsv(ledger: Ledger, release: { as_of: string }): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of ledger.rows) {
    lines.push(
      [
        cell(row.company_id),
        cell(row.name),
        cell(row.ticker),
        percent(row.weight),
        cell(row.held_directly ? "yes" : "no"),
        cell(row.holder_count),
        cell(row.sources.map(describeSource).join("; ")),
        cell(release.as_of),
      ].join(","),
    );
  }
  // A trailing newline, because a file without one is the classic "and the last line
  // was silently dropped" bug in someone else's parser.
  return `${lines.join("\n")}\n`;
}

/** `unpackfund-ledger-2026-11-02.csv` — the date the visitor exported it. */
export function ledgerCsvName(now: Date, releaseAsOf: string): string {
  const date = now.toISOString().slice(0, 10);
  return `unpackfund-ledger-${date}-${releaseAsOf.replace(/[^0-9A-Za-z._-]/g, "_")}.csv`;
}

/**
 * Hand a string to the browser as a download, without touching the network.
 *
 * The object URL is revoked on the next frame rather than immediately: Safari has
 * cancelled downloads whose URL was revoked in the same task as the click.
 */
export function saveCsv(text: string, filename: string): void {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
