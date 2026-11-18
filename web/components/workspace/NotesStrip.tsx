"use client";

/**
 * The notes that appear under the metric strip, and only when they apply.
 *
 * Every one of these was a paragraph that used to be always on screen: "some funds are partly
 * traced, so these figures are minimums" was true for every portfolio that had one, and a
 * portfolio with none still read it. A note here appears because the data on screen makes it
 * true, and disappears otherwise — which is the whole difference between a caveat and noise.
 *
 * Four notes, always in this order, at most four lines: WITHHELD, PARTIAL, SHORTS, DATES.
 * The component renders nothing at all when none of them fires — not an empty box.
 */

import type { WorkspaceModel } from "@/lib/use-workspace";
import { formatPct1Of, formatDateLong } from "@/lib/format";

import styles from "./Workspace.module.css";

export type NoteTone = "warning" | "info";

export interface WorkspaceNote {
  id: "CN_WITHHELD" | "CN_PARTIAL" | "CN_SHORTS" | "CN_DATES";
  tone: NoteTone;
  text: string;
}

/** `A, B and C` — a comma list that reads as a sentence. */
function listOf(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0] as string;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The notes for this portfolio, in display order.
 *
 * Reads the ledger, never the portfolio entries: the ledger is the merged view whose coverage
 * numbers are the ones the concentration figures are withheld against, so a note and the
 * figure it explains cannot disagree.
 */
export function buildNotes(model: WorkspaceModel): WorkspaceNote[] {
  const ledger = model.ledger;
  if (ledger === null) return [];

  const notes: WorkspaceNote[] = [];

  const funds = ledger.funds as Array<{
    ticker: string;
    coverage_pct: number;
    as_of: string;
  }>;
  const withheld = funds
    .filter((fund) => fund.coverage_pct < 60)
    .map((fund) => fund.ticker);
  const partial = funds
    .filter((fund) => fund.coverage_pct >= 60 && fund.coverage_pct < 70)
    .map((fund) => fund.ticker);

  if (withheld.length > 0) {
    notes.push({
      id: "CN_WITHHELD",
      tone: "warning",
      text: `${listOf(withheld)} ${withheld.length === 1 ? "is" : "are"} under 60% traced, so concentration figures are withheld.`,
    });
  }

  if (partial.length > 0) {
    notes.push({
      id: "CN_PARTIAL",
      tone: "warning",
      text: `${listOf(partial)} ${partial.length === 1 ? "is" : "are"} partly traced (60–70%), so figures that use ${partial.length === 1 ? "it" : "them"} are minimums.`,
    });
  }

  // A negative row weight is a short: it is real weight but a concentration figure cannot use
  // it, so the reader is told why it is not in the total.
  const shortWeight = ledger.rows.reduce(
    (sum, row) => (row.weight < 0 ? sum + row.weight : sum),
    0,
  );
  if (shortWeight < 0) {
    notes.push({
      id: "CN_SHORTS",
      tone: "info",
      text: `Short positions (${formatPct1Of(Math.abs(shortWeight) * 100)}) are listed but left out of concentration figures.`,
    });
  }

  const periods = [...new Set(funds.map((fund) => fund.as_of).filter(Boolean))].sort();
  if (periods.length > 1) {
    notes.push({
      id: "CN_DATES",
      tone: "info",
      text: `Holdings dates range from ${formatDateLong(periods[0] as string)} to ${formatDateLong(periods[periods.length - 1] as string)}.`,
    });
  }

  return notes;
}

export function NotesStrip({ model }: { model: WorkspaceModel }) {
  const notes = buildNotes(model);
  // Renders nothing at all when nothing applies — not a placeholder, not a border.
  if (notes.length === 0) return null;

  return (
    <ul className={styles.notes} aria-label="Notes about this portfolio">
      {notes.map((note) => (
        <li key={note.id} className={styles.note} data-tone={note.tone}>
          <span className={styles.noteIcon} aria-hidden="true">
            {note.tone === "warning" ? "!" : "i"}
          </span>
          <span>{note.text}</span>
        </li>
      ))}
    </ul>
  );
}
