/**
 * The arithmetic of one comparison column, separated from how it is drawn.
 *
 * A side is a list of funds and their shares of the whole mix, in integer basis
 * points. Everything here is a pure function of that list, so the two buttons that
 * rewrite a column ("Scale to 100%", "Split equally") can be tested by their
 * numbers rather than by clicking.
 */

import { equalise } from "@/lib/portfolio-weights";
import { FULL_ALLOCATION_BP } from "@/lib/types";
import type { FundWeight, PortfolioEntry } from "@/lib/types";

/**
 * A typed percentage as basis points: `"12.5"` → `1250`, `""` → `null`.
 *
 * The field is a text input in percent, not a number input: a number input on a
 * phone offers a keypad with no minus and no letters, and its spinner arrows fight
 * the tabular-figure column they sit in. So the text is parsed here, once, and the
 * parse is total — anything that is not a non-negative number returns `null` and
 * the field simply does not write.
 *
 * Rounding is to the nearest basis point (two decimals of a percent), which is the
 * precision the field displays. The caller clamps to 100%; this function does not,
 * because "150" should clamp once, in the store, not silently here.
 */
export function percentToBp(input: string): number | null {
  // Only digits, one decimal point, and the decorations a person actually types
  // around a percentage. Anything else — a sign, an exponent, a second point — is
  // not a number this field should quietly reinterpret.
  const cleaned = input.replace(/[\s,%]/g, "");
  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === "" || cleaned === ".") return null;
  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

/**
 * The whole mix split evenly across the funds on the side.
 *
 * Delegates to `portfolio-weights.equalise` — the same function the builder uses
 * when it starts a portfolio — so "evenly" means the same integers on both
 * surfaces: 10,000 basis points, remainder to the first row.
 */
export function splitEvenly(funds: readonly FundWeight[]): FundWeight[] {
  if (funds.length === 0) return [];
  const entries: PortfolioEntry[] = funds.map((fund) => ({
    kind: "fund",
    key: fund.ticker,
    amount: fund.weight_bp,
  }));
  return equalise(entries).map((entry) => ({
    ticker: entry.key,
    weight_bp: entry.amount,
  }));
}

/**
 * The same proportions, scaled so the side totals exactly 100%.
 *
 * Not a normalisation of the comparison — the answer is withheld when a side is
 * incomplete, and this button is how the visitor fixes the side themselves. The
 * two are different acts: a view that silently divides by 88% answers a question
 * about a portfolio the visitor does not hold, while a button that says "scale to
 * 100%" moves the numbers on screen and leaves the URL describing the result.
 *
 * Largest-remainder rounding, so the total is 10,000 exactly and no fund loses
 * more than a basis point to the floor. Ties break by row order, which keeps the
 * output stable across renders.
 *
 * A side of all-zero weights has no proportion to keep; it becomes an even split,
 * which is the only reading of "scale nothing to 100%" that has an answer.
 */
export function scaleToWhole(funds: readonly FundWeight[]): FundWeight[] {
  if (funds.length === 0) return [];
  const weights = funds.map((fund) => Math.max(0, fund.weight_bp));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return splitEvenly(funds);

  const raw = weights.map((weight) => (weight * FULL_ALLOCATION_BP) / total);
  const amounts = raw.map((value) => Math.floor(value));
  const used = amounts.reduce((sum, amount) => sum + amount, 0);
  const remaining = FULL_ALLOCATION_BP - used;
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((x, y) => y.fraction - x.fraction || x.index - y.index);
  for (let i = 0; i < remaining; i += 1) {
    // `remaining` is at most one less than the row count (each row loses less than
    // a point to the floor), so the modulo never wraps in practice; it is here so a
    // future change to the rounding cannot read past the end.
    const target = order[i % order.length];
    if (!target) break;
    amounts[target.index] = (amounts[target.index] ?? 0) + 1;
  }

  return funds.map((fund, index) => ({
    ticker: fund.ticker,
    weight_bp: amounts[index] ?? 0,
  }));
}

/** Whether the side is already the even split `splitEvenly` would produce. */
export function isSplitEvenly(funds: readonly FundWeight[]): boolean {
  if (funds.length === 0) return false;
  const even = splitEvenly(funds);
  return funds.every((fund, index) => fund.weight_bp === even[index]?.weight_bp);
}
