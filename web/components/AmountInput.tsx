"use client";

/**
 * The amount field: percent in `%` mode, dollars in `$` mode.
 *
 * The draft string is local so a half-typed "12." does not round-trip through the
 * URL as 12 — the store only ever sees a parsed integer (basis points or cents), and
 * the field only ever shows what the user typed until they leave it.
 *
 * The two modes are not two fields with the same job: a percent is a share of the
 * portfolio, a dollar amount is money the visitor has. Converting one to the other
 * is the builder's explicit decision, never an implicit re-interpretation.
 */

import { useState } from "react";

import { formatCents } from "@/lib/format";
import type { EntryMode } from "@/lib/types";

function formatPercent(amount: number): string {
  return (amount / 100).toFixed(2);
}

function formatDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function AmountInput({
  label,
  mode,
  amount,
  onChange,
}: {
  /** What the field is for, read by a screen reader: "Portfolio weight for VT". */
  label: string;
  mode: EntryMode;
  /** Basis points in `%` mode, cents in `$` mode. */
  amount: number;
  onChange: (amount: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // What this field last asked the store to hold. When the store keeps something
  // else — it caps a single row at the whole, 100% in percent mode — the typed text is
  // a number the portfolio does not contain, so the field shows the store's value
  // instead. The portfolio's *total* is never capped: overshooting is a normal step
  // while filling in rows one at a time.
  const [sent, setSent] = useState<number | null>(null);
  if (draft !== null && sent !== null && amount !== sent) {
    setDraft(null);
    setSent(null);
  }
  const value = draft ?? (mode === "bp" ? formatPercent(amount) : formatDollars(amount));

  return (
    <span className="weight-input">
      {mode === "usd" ? <span aria-hidden="true">$</span> : null}
      <input
        type="text"
        inputMode="decimal"
        aria-label={mode === "bp" ? `${label}, in percent` : `${label}, in dollars`}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const parsed = Number.parseFloat(next.replace(/[^0-9.]/g, ""));
          if (Number.isFinite(parsed)) {
            // Percent → basis points, dollars → cents. Both are integers, because
            // the fragment stores integers and a float would round differently on
            // two machines. The two branches look alike and are not: ×100 turns a
            // percentage into basis points, and dollars into cents.
            const whole = Math.round(mode === "bp" ? parsed * 100 : parsed * 100);
            setSent(whole);
            onChange(whole);
          }
        }}
        onBlur={() => setDraft(null)}
      />
      {mode === "bp" ? (
        <span aria-hidden="true">%</span>
      ) : (
        <span className="sr-only">{formatCents(amount)}</span>
      )}
    </span>
  );
}
