"use client";

/**
 * A weight field, in percent, held as basis points.
 *
 * The draft string is local so a half-typed "12." does not round-trip through the
 * URL as 12 — the store only ever sees a parsed number, and the field only ever
 * shows what the user typed until they leave it.
 */

import { useState } from "react";

function formatPercent(weightBp: number): string {
  return (weightBp / 100).toFixed(2);
}

export function WeightInput({
  ticker,
  weightBp,
  onChange,
}: {
  ticker: string;
  weightBp: number;
  onChange: (weightBp: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? formatPercent(weightBp);

  return (
    <span className="weight-input">
      <input
        type="text"
        inputMode="decimal"
        aria-label={`Portfolio weight for ${ticker}, in percent`}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const parsed = Number.parseFloat(next.replace(/[^0-9.]/g, ""));
          if (Number.isFinite(parsed)) onChange(Math.round(parsed * 100));
        }}
        onBlur={() => setDraft(null)}
      />
      <span aria-hidden="true">%</span>
    </span>
  );
}
