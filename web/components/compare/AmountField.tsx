"use client";

import { useState } from "react";

import styles from "./compare.module.css";
import { percentToBp } from "./sides";

/**
 * One fund's share of its mix, as a percentage.
 *
 * The draft lives in the field so the visitor can type "1" on the way to "12.5"
 * without the store rewriting the row after the first keystroke — the same problem
 * the builder's amount field solves the same way. The draft is dropped when the
 * value it was derived from changes underneath it (a clamp at 100%, a swap of the
 * two sides), which is what makes "150" show as 100 rather than staying as a number
 * the page has already refused.
 */
export function AmountField({
  label,
  weightBp,
  onChange,
}: {
  label: string;
  weightBp: number;
  onChange: (weightBp: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [sent, setSent] = useState<number | null>(null);

  if (draft !== null && sent !== null && sent !== weightBp) {
    // The store clamped or replaced the value: show what it holds, not what was typed.
    setDraft(null);
    setSent(null);
  }

  return (
    <span className={styles.amount}>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        maxLength={6}
        className={styles.amountInput}
        aria-label={`${label}, in percent`}
        value={draft ?? (weightBp / 100).toFixed(2)}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const parsed = percentToBp(next);
          if (parsed === null || parsed === weightBp) return;
          setSent(parsed);
          onChange(parsed);
        }}
        onBlur={() => {
          setDraft(null);
          setSent(null);
        }}
      />
      <span className={styles.amountSuffix} aria-hidden="true">
        %
      </span>
    </span>
  );
}
