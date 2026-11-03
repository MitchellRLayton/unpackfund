/**
 * The orders the funds table can be read in.
 *
 * Two kinds, and the difference is a rule rather than a convenience:
 *
 * - **Release orders** (`assets`, `popular`, `alpha`) come from
 *   `lib/directory.ts`'s `sortRows`, which is already tested and is the only
 *   implementation of "largest first" (the catalogue's fifth element, the fund's
 *   own filed N-PORT net assets) and "widely held first" (the editorial list in
 *   `lib/popular.ts`). The page opens on `defaultSort(rows)`, so a release that
 *   predates the net-assets field opens on the editorial order and says so.
 * - **Column orders** sort the four columns the table actually prints. They are
 *   presentation, not a ranking: no score is computed, two rows never trade
 *   places for any reason but the column's own value, and ties always break on
 *   the ticker so the same table is the same order twice.
 *
 * Comparison is by lower-cased code unit rather than `localeCompare`. Locale
 * collation is not stable across ICU versions, and a directory whose order
 * changes with the browser is a different answer on a different machine; a
 * plain A–Z on ASCII filing names is reproducible everywhere. Names that are
 * not ASCII sort after the ASCII ones by their code points, which is the same
 * order the raw catalogue file is in.
 */

import {
  defaultSort,
  sortRows,
  type DirectoryRow,
  type DirectorySort,
} from "@/lib/directory";

/** The columns that print a value a reader can order by. */
export type ColumnKey = "ticker" | "name" | "issuer" | "coverage" | "assets";

export type Direction = "ascending" | "descending";

export type Order =
  | { kind: DirectorySort }
  | { kind: "column"; key: ColumnKey; direction: Direction }
  | { kind: "search" };

export const COLUMN_LABELS: Record<ColumnKey, string> = {
  ticker: "Ticker",
  name: "Fund",
  issuer: "Issuer",
  coverage: "Coverage",
  assets: "Fund size",
};

/** The order a page opens on: whatever `directory.ts` says this release supports. */
export function defaultOrder(rows: DirectoryRow[]): Order {
  return { kind: defaultSort(rows) };
}

function compareText(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

function byTicker(a: DirectoryRow, b: DirectoryRow): number {
  return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
}

/**
 * Where a row with no figure for this column belongs: after every row that has one,
 * in both directions. A release older than the net-assets field must not sort its
 * blank cells to the top when the reader flips the arrow.
 */
function missingRank(row: DirectoryRow, key: ColumnKey): number {
  return key === "assets" && row.netAssets === null ? 1 : 0;
}

function compareColumn(a: DirectoryRow, b: DirectoryRow, key: ColumnKey): number {
  switch (key) {
    case "assets":
      // `missingRank` has already separated the rows that have a figure.
      return (a.netAssets ?? 0) - (b.netAssets ?? 0);
    case "name":
      return compareText(a.name, b.name);
    case "issuer":
      return compareText(a.issuer, b.issuer);
    case "coverage":
      // A missing coverage is not a low one, but the catalogue always carries the
      // number (it is a resolution percentage), so there is no null case here.
      return a.coverage - b.coverage;
    case "ticker":
    default:
      return byTicker(a, b);
  }
}

/**
 * Rows in the order asked for. Pure: the input array is never mutated.
 *
 * The direction multiplies the column comparison rather than reversing the sorted
 * array, and the ticker tiebreak is applied after it, so a descending name order
 * still lists two names that differ only in case in one fixed order. Reversing
 * would flip the ties too, which is how a table becomes a different table after
 * one more click.
 */
export function orderRows(rows: DirectoryRow[], order: Order): DirectoryRow[] {
  // `search` is the order the ranker already produced: nothing is re-sorted, so
  // "closest match" means the ladder's answer and not a second opinion.
  if (order.kind === "search") return [...rows];
  if (order.kind !== "column") return sortRows(rows, order.kind);
  const sign = order.direction === "descending" ? -1 : 1;
  return [...rows].sort(
    (a, b) =>
      missingRank(a, order.key) - missingRank(b, order.key) ||
      sign * compareColumn(a, b, order.key) ||
      byTicker(a, b),
  );
}

/**
 * What a header click asks for next: the same column flips, a new column starts
 * in its natural direction.
 *
 * Coverage starts most-covered first because the reader is usually asking "which
 * funds can I trust the numbers of", and fund size starts largest first because
 * that is the question that column is for; the text columns start A–Z, which is
 * what a header arrow pointing up usually means.
 */
export function nextOrder(current: Order, key: ColumnKey): Order {
  if (current.kind === "column" && current.key === key) {
    return {
      kind: "column",
      key,
      direction: current.direction === "ascending" ? "descending" : "ascending",
    };
  }
  return {
    kind: "column",
    key,
    // A reader clicking "Fund size" wants the largest first; coverage most-covered;
    // the text columns A–Z.
    direction: key === "coverage" || key === "assets" ? "descending" : "ascending",
  };
}

/** The `aria-sort` a column header carries, or `undefined` when it is not sorted. */
export function ariaSortFor(order: Order, key: ColumnKey): Direction | undefined {
  if (order.kind === "column") return order.key === key ? order.direction : undefined;
  // A–Z by ticker is a column order too, and saying so keeps the arrow honest.
  return order.kind === "alpha" && key === "ticker" ? "ascending" : undefined;
}

/**
 * The order in words, for the caption.
 *
 * Stated rather than inferred: a table whose caption does not say what its order
 * means invites the reader to guess, and "largest" is a claim about the data
 * that only the release can support.
 */
export function orderDescription(order: Order): string {
  switch (order.kind) {
    case "assets":
      return "largest first by the fund's own filed N-PORT net assets";
    case "popular":
      return "widely held funds first (an editorial list, not a size ranking)";
    case "alpha":
      return "by ticker";
    case "search":
      return "closest match first";
    case "column": {
      const label = COLUMN_LABELS[order.key];
      const direction = order.direction === "ascending" ? "ascending" : "descending";
      if (order.key === "coverage") {
        return direction === "descending"
          ? "by coverage, most covered first"
          : "by coverage, least covered first";
      }
      if (order.key === "assets") {
        return direction === "descending"
          ? "by filed net assets, largest first"
          : "by filed net assets, smallest first";
      }
      return `by ${label.toLowerCase()}, ${direction}`;
    }
  }
}

/** Select value for an order, so the control and the headers can never disagree. */
export function orderValue(order: Order): string {
  return order.kind === "column" ? "column" : order.kind;
}
