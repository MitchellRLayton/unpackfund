/**
 * The two whole-portfolio helpers the holdings pane needs.
 *
 * A percentage portfolio is only a portfolio when it accounts for all of itself
 * (`fragment.isComplete`), so the pane shows the visitor how far short it is and offers
 * one explicit way to close the gap: scale every row up so the set totals exactly
 * 10,000 basis points. That is a *visitor's* decision, never an automatic one — moving
 * a number they typed is silent data loss, which is why the button exists instead of
 * an effect.
 *
 * Scaling uses the largest-remainder method: floor each proportional share, then hand
 * the left-over basis points to the rows with the largest fractional parts (ties to the
 * earlier row, so the answer is deterministic). Every row lands within one basis point
 * of its exact share, the total is exactly 10,000, and a 60/30 split becomes
 * 66.67% / 33.33% rather than 66.66% / 33.34%.
 *
 * Both functions are pure and tested by hand-computed cases (`total.test.ts`), because
 * a total a reader can add up two different ways is the kind of bug this app cannot
 * afford (`lookthrough-math-and-qa` §6).
 */

/** 100% in basis points. The denominator every percentage portfolio must reach. */
export const WHOLE_BP = 10_000;

/**
 * What is left of the whole, in basis points.
 *
 * Amounts are clamped to zero before summing because a negative row is not money; the
 * store refuses one, and a view that quietly subtracted it would report a total the
 * store does not hold. Over-allocation returns 0 rather than a negative: "unallocated"
 * and "over" are different states, and the pane renders them differently.
 */
export function unallocatedOf(amounts: readonly number[], wholeBp = WHOLE_BP): number {
  const used = amounts.reduce((sum, amount) => sum + Math.max(0, Math.round(amount)), 0);
  return Math.max(0, wholeBp - used);
}

/**
 * Rescale `amounts` so they sum to exactly `wholeBp`, keeping their proportions.
 *
 * The empty list and an all-zero list both return zeros: there is no proportion to
 * preserve in either, and division by a zero total is the one thing this function must
 * never do.
 */
export function scaleToWhole(amounts: readonly number[], wholeBp = WHOLE_BP): number[] {
  const clean = amounts.map((amount) => Math.max(0, Math.round(amount)));
  if (clean.length === 0) return [];
  const total = clean.reduce((sum, amount) => sum + amount, 0);
  if (total <= 0) return clean.map(() => 0);

  const exact = clean.map((amount) => (amount * wholeBp) / total);
  const scaled = exact.map((value) => Math.floor(value));
  let left = wholeBp - scaled.reduce((sum, value) => sum + value, 0);
  if (left <= 0) return scaled;

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (const { index } of order) {
    if (left <= 0) break;
    scaled[index] = (scaled[index] ?? 0) + 1;
    left -= 1;
  }
  // Floating point can leave a stray point after one pass (`exact` sums to `wholeBp`
  // only up to rounding). The first row is the documented place it goes; the invariant
  // that matters is that the total is exactly the whole.
  if (left > 0) scaled[0] = (scaled[0] ?? 0) + left;

  return scaled;
}
