/**
 * Reading a pasted list: one ticker and one amount per line.
 *
 * The paste box exists because the alternative is typing eight rows and then eight
 * amounts, and because the list a visitor actually has is usually already a list — in a
 * spreadsheet, a note, or a message from someone else. So the box accepts the shapes
 * people write: `VTI 40%`, `VXUS $12,000`, `VTI 40`, `BND`, bullets and numbering
 * included, and `cash` as a word.
 *
 * Three rules keep it honest:
 *
 * 1. **A bare number is a percentage.** `VTI 40` is 40% of the portfolio, not $40: the
 *    percentage is the unit this app is about, and a bare amount read as dollars would
 *    silently mean something the visitor did not write. Dollars are written `$12,000`.
 * 2. **A dollar amount cannot be read in percentage mode.** What share of 100% is
 *    `$12,000`? The question has no answer until a total exists, so the line is refused
 *    with a sentence pointing at the toggle rather than converted to a number nobody
 *    asked for. The other direction *is* defined — the toggle's own $10,000 notional, so
 *    40% is $4,000 — and that is what this module uses.
 * 3. **The preview says what the add will do.** Whether a line is addable, what it will
 *    be called and what amount it will carry are all decided here, before anything is
 *    written, so the visitor can see the reading before it is committed.
 *
 * Whether a symbol *exists* is not this module's question: that is
 * `lib/holdings.resolveEntry`'s, one line at a time, against the release. This module
 * only turns text into a key and an amount.
 */

import { formatCents, formatWeightBp } from "@/lib/format";
import { classifyInput } from "@/lib/holdings";
import { bpToCents } from "@/lib/portfolio-weights";
import { CASH_KEY, FULL_ALLOCATION_BP, type EntryMode } from "@/lib/types";

/**
 * The ceiling one row may carry in dollars, mirroring the store's own (`use-portfolio`
 * caps a single row so a hand-edited link cannot hold a number no view can use). A row
 * above it is refused here rather than clamped, because a preview that shows one number
 * and writes another is the failure this box exists to prevent.
 */
const MAX_ROW_CENTS = 100_000_000_00;

/** One line, as text understands it. Whether the symbol exists is a later question. */
export interface PasteRow {
  /** The line as pasted, trimmed — the preview and the refusal quote it. */
  raw: string;
  /** The normalised symbol, or `CASH`. */
  key: string;
  /** Cash is a word, not a symbol: it must not be handed to a ticker lookup. */
  isCash: boolean;
  /** The percentage as a number (`40`), when the line carried a percent or a bare amount. */
  percent: number | null;
  /** Exact cents, when the line carried a dollar amount. */
  cents: number | null;
  /** Why this line cannot become a holding, when it cannot. */
  problem?: string;
}

/** A line as the pane will act on it: an amount in the portfolio's own unit. */
export interface PasteLine {
  raw: string;
  /** What the row will be called: the ticker, or `Cash`. */
  label: string;
  /** Basis points in percentage mode, cents in dollar mode, `0` when no amount was given. */
  amount: number;
  /** The amount in the mode's unit, for the preview. */
  amountText: string;
  problem?: string;
}

/** `$`, a number with optional thousands separators and decimals, then an optional `%`. */
const AMOUNT = /^(\$)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(%)?$/;

/** A leading bullet or list number is formatting, not content. */
const LIST_MARKER = /^(?:[-*•·]|\d+[.)])\s+/;

/** `VTI: 40%` and `VTI = 40%` are the same line. */
const SEPARATOR = /\s*[:=]\s*/;

function normaliseLine(raw: string): string {
  return raw
    .trim()
    .replace(/\t/g, " ")
    .replace(/ {2,}/g, " ")
    .replace(LIST_MARKER, "")
    .replace(SEPARATOR, " ")
    .trim();
}

function amountOf(
  rest: string,
  row: PasteRow,
): { percent: number | null; cents: number | null } {
  if (rest.length === 0) return { percent: null, cents: null };
  const match = AMOUNT.exec(rest);
  if (!match) {
    row.problem = `Could not read “${rest}” as an amount. One ticker and an amount per line.`;
    return { percent: null, cents: null };
  }
  const [, dollarSign, digits, percentSign] = match;
  const value = Number((digits ?? "").replace(/,/g, ""));
  if (!Number.isFinite(value)) {
    row.problem = `“${rest}” is not a number.`;
    return { percent: null, cents: null };
  }
  if (dollarSign && percentSign) {
    row.problem = `“${rest}” is both a dollar amount and a percentage.`;
    return { percent: null, cents: null };
  }
  if (dollarSign) {
    const cents = Math.round(value * 100);
    if (cents > MAX_ROW_CENTS) {
      row.problem = `“${rest}” is more than one row may hold.`;
      return { percent: null, cents: null };
    }
    return { percent: null, cents };
  }
  if (value > FULL_ALLOCATION_BP / 100) {
    row.problem = `“${rest}” is more than 100%, and one row cannot be.`;
    return { percent: null, cents: null };
  }
  return { percent: value, cents: null };
}

/**
 * Split a pasted block into rows.
 *
 * Every line becomes a row — including the ones that failed — because the preview's job
 * is to show the visitor what was understood, and a line silently dropped is the thing
 * that makes a paste untrustworthy. Blank lines are the exception: they carry nothing.
 */
export function parsePaste(text: string): PasteRow[] {
  const rows: PasteRow[] = [];
  const seen = new Map<string, number>();

  for (const raw of text.split(/\r?\n/)) {
    const line = normaliseLine(raw);
    if (line.length === 0) continue;

    const [first = "", ...rest] = line.split(" ");
    const row: PasteRow = {
      raw: raw.trim(),
      key: "",
      isCash: false,
      percent: null,
      cents: null,
    };

    const shape = classifyInput(first);
    if (shape.kind === "invalid") {
      row.key = first.toUpperCase();
      row.problem = shape.title;
      rows.push(row);
      continue;
    }
    if (shape.kind === "cash") {
      row.key = CASH_KEY;
      row.isCash = true;
    } else {
      row.key = shape.ticker;
    }

    const amounts = amountOf(rest.join(" "), row);
    row.percent = amounts.percent;
    row.cents = amounts.cents;

    const firstAt = seen.get(row.key);
    if (firstAt !== undefined) {
      row.problem = `Listed twice: this line repeats line ${firstAt + 1}.`;
    } else {
      seen.set(row.key, rows.length);
    }
    rows.push(row);
  }

  return rows;
}

/**
 * The amount a row will write, in the portfolio's own unit, or the reason it cannot.
 *
 * Percentage mode refuses a dollar amount (see rule 2 in the module comment); dollar
 * mode converts a percentage at the toggle's own $10,000 notional, which is the same
 * conversion `convertMode` performs when the visitor flips the switch — so a pasted
 * `VTI 40%` in dollar mode and a row typed as 40% then switched to dollars agree.
 */
function amountIn(
  row: PasteRow,
  mode: EntryMode,
): { amount: number } | { problem: string } {
  if (row.problem) return { problem: row.problem };
  if (row.percent !== null) {
    const bp = Math.round(row.percent * 100);
    return { amount: mode === "bp" ? bp : bpToCents(bp) };
  }
  if (row.cents !== null) {
    if (mode === "bp") {
      return {
        problem: `A dollar amount needs dollar mode: what share of 100% is ${formatCents(
          row.cents,
        )}? Switch the toggle to dollars to add it.`,
      };
    }
    return { amount: row.cents };
  }
  return { amount: 0 };
}

/** What the preview shows, line by line, before anything is written. */
export function previewPaste(rows: readonly PasteRow[], mode: EntryMode): PasteLine[] {
  return rows.map((row) => {
    const resolved = amountIn(row, mode);
    const label = row.isCash ? "Cash" : row.key;
    if ("problem" in resolved) {
      return {
        raw: row.raw,
        label,
        amount: 0,
        amountText: "—",
        problem: resolved.problem,
      };
    }
    return {
      raw: row.raw,
      label,
      amount: resolved.amount,
      amountText:
        resolved.amount === 0 && row.percent === null && row.cents === null
          ? "no weight yet"
          : mode === "bp"
            ? formatWeightBp(resolved.amount)
            : formatCents(resolved.amount),
    };
  });
}

/** How many lines of a preview are addable, for the button's own words. */
export function previewCounts(lines: readonly PasteLine[]): {
  usable: number;
  refused: number;
} {
  let usable = 0;
  let refused = 0;
  for (const line of lines) {
    if (line.problem) refused += 1;
    else usable += 1;
  }
  return { usable, refused };
}
