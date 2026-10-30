import {
  coverageLabel,
  formatCount,
  formatCoveragePct,
  formatDays,
  formatRatio,
  formatShare,
} from "@/lib/format";
import type { Ledger, ReleaseDescriptor } from "@/lib/types";

/**
 * The scorecard: what the numbers are, where they came from, and how old they
 * are — in that order, before any number that could be mistaken for current.
 *
 * Nothing here is "today". A filing period is a quarter-end, a filing date is
 * when EDGAR received it, and a lag is the gap between the two; collapsing them
 * into "updated" would be the one misleading thing this product cannot afford.
 */
export function FreshnessStrip({
  release,
  ledger,
}: {
  release: ReleaseDescriptor;
  ledger: Ledger;
}) {
  const funds = ledger.funds;
  const period =
    ledger.oldest_as_of === null
      ? "—"
      : funds.every((fund) => fund.as_of === ledger.oldest_as_of)
        ? ledger.oldest_as_of
        : `${ledger.oldest_as_of} – ${funds
            .map((fund) => fund.as_of)
            .sort()
            .at(-1)}`;

  return (
    <section aria-labelledby="freshness-heading">
      <h2 id="freshness-heading" className="sr-only">
        Where these numbers come from
      </h2>
      <div className="strip">
        <div className="strip__cell">
          <span className="strip__label">Release</span>
          <span className="strip__value">{release.as_of}</span>
          <span className="strip__note">
            built {release.generated_at.slice(0, 10)} UTC ·{" "}
            {release.pipeline_git_sha.slice(0, 7)}
          </span>
        </div>
        <div className="strip__cell">
          <span className="strip__label">Filing period</span>
          <span className="strip__value">{period}</span>
          <span className="strip__note">
            {funds.length === 1
              ? "the one fund in this portfolio"
              : `oldest of ${funds.length} funds`}
          </span>
        </div>
        <div className="strip__cell">
          <span className="strip__label">Longest lag</span>
          <span className="strip__value">
            {ledger.max_lag_days === null ? "—" : formatDays(ledger.max_lag_days)}
          </span>
          <span className="strip__note">period end to SEC filing</span>
        </div>
        <div className="strip__cell">
          <span className="strip__label">Coverage</span>
          <span className="strip__value">
            {formatCoveragePct(ledger.metrics.covered_weight_pct)}
          </span>
          <span className="strip__note">
            {coverageLabel(ledger.metrics.covered_weight_pct)}
          </span>
        </div>
        <div className="strip__cell">
          <span className="strip__label">Companies</span>
          <span className="strip__value">{formatCount(ledger.rows.length)}</span>
          <span className="strip__note">
            {ledger.unmapped_holdings === 0
              ? "every holding mapped"
              : `${formatCount(ledger.unmapped_holdings)} holdings unmapped`}
          </span>
        </div>
      </div>
    </section>
  );
}

/**
 * Concentration, from the summed ledger weights (math §2).
 *
 * `effective_n` is `1/HHI`, the number of equally weighted companies that would
 * produce the same spread — far more legible than 0.0197. The labels here are the
 * ones the 8,983 generated fund pages use, and the notes are the fund pages'
 * one-line explanations: two surfaces showing the same three numbers under
 * different names is the drift that makes a reader think they are different
 * metrics. `components.test.tsx` pins the labels.
 */
export function MetricsList({ ledger }: { ledger: Ledger }) {
  const { hhi, effective_n: effectiveN, top10 } = ledger.metrics;
  return (
    <ul className="metrics">
      <li>
        <dt>Concentration</dt>
        <dd>
          <strong>{hhi === null ? "not computable" : formatRatio(hhi, 4)}</strong>
        </dd>
        <p className="metric-note">0 = spread evenly, 1 = all in one company.</p>
      </li>
      <li>
        <dt>Same-size companies</dt>
        <dd>
          <strong>
            {effectiveN === null ? "not computable" : formatRatio(effectiveN, 1)}
          </strong>
        </dd>
        <p className="metric-note">
          How many equal-sized companies would be spread the same way.
        </p>
      </li>
      <li>
        <dt>Biggest 10 companies</dt>
        <dd>
          <strong>{top10 === null ? "not computable" : formatShare(top10)}</strong>
        </dd>
        <p className="metric-note">Their share of your money.</p>
      </li>
    </ul>
  );
}
