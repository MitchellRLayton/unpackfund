"use client";

/**
 * The four lenses' shared furniture.
 *
 * A lens is a pure function of the workspace model, and this file is the only
 * place it is allowed to touch the DOM's edges: the state that says what is
 * missing, the section heading with its export, and the coverage chip whose words
 * come from `lib/format` so no lens can invent a band label of its own.
 *
 * Nothing here computes a number. `CoverageChip` prints the percentage in **every**
 * band including the one whose label is "not covered" — a cell that replaced the
 * number with a word would say nothing about how much of a fund was traced, and the
 * band is the qualifier, never the measurement.
 */

import type { ReactNode } from "react";

import { coverageBand, coverageChip } from "@/lib/format";
import type { WorkspaceModel } from "@/lib/use-workspace";

/** Loading and empty states: say what the lens is waiting for, in plain words. */
export function LensState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty" role="status">
      <p className="empty__title">{title}</p>
      <p className="muted small">{body}</p>
    </div>
  );
}

/**
 * The lens's answer, in the design system's answer strip.
 *
 * One sentence, every number in it printed again in a table below — the strip is a
 * summary of tables that exist, never a figure that lives only here.
 */
export function LensAnswer({ children }: { children: ReactNode }) {
  return <p className="answer">{children}</p>;
}

/** One sentence above the first table, describing what the lens answers. */
export function LensLede({ children }: { children: ReactNode }) {
  return <p className="small muted">{children}</p>;
}

/** A heading, an optional action on the right, and its content. */
export function LensSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="stack stack--tight">
      <div className="row row--between">
        <h2 className="subtitle">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * The download. The CSV is built when it is clicked, not on every render, and the
 * filename carries the release because a spreadsheet outlives the page.
 */
export function LensExport({
  label,
  onExport,
}: {
  /** What the file holds, in words, for the button's accessible name. */
  label: string;
  onExport: () => void;
}) {
  return (
    <button
      type="button"
      className="btn btn--sm"
      onClick={onExport}
      aria-label={`Export CSV: ${label}`}
    >
      Export CSV
    </button>
  );
}

/** Coverage as the design system's chip: the band is colour *and* words. */
export function CoverageChip({ pct }: { pct: number }) {
  return <span className={`chip chip--${coverageBand(pct)}`}>{coverageChip(pct)}</span>;
}

/**
 * A link that decoded only partly. The shell may also warn; a lens whose numbers
 * are drawn from the part that did decode must say so next to them, because
 * otherwise the table looks complete.
 */
export function LensProblem({ model }: { model: WorkspaceModel }) {
  if (!model.problem) return null;
  return (
    <p className="notice notice--alert" role="alert">
      {model.problem}
    </p>
  );
}

/**
 * A second line inside a table cell: the qualifier under the number.
 *
 * It renders the design system's `.note` (block, 12px, graphite) rather than a
 * lens-local rule, so a table anywhere on the site can add the same second line
 * without a second definition of one.
 */
export function CellNote({ children }: { children: ReactNode }) {
  return <span className="note">{children}</span>;
}
