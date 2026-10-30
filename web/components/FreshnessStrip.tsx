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
          <span className="strip__label">Unique companies</span>
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
 * The three headline numbers, in plain words (math §2).
 *
 * `effective_n` is `1/HHI`, the number of equally weighted companies that would
 * produce the same spread. The old label — "effective companies" — was a term of
 * art; "same-size companies" says what the number is, and the note explains why
 * it is lower than the number of companies in the table. The HHI keeps its own
 * card, but with the 0-to-1 scale spelled out.
 */
export function MetricsList({ ledger }: { ledger: Ledger }) {
  const { hhi, effective_n: effectiveN, top10 } = ledger.metrics;
  const companies = ledger.rows.length;
  const sameSize = effectiveN === null ? null : formatRatio(effectiveN, 1);
  return (
    <ul className="metrics">
      <li>
        <dt>Same-size companies</dt>
        <dd>
          <strong>{sameSize ?? "not computable"}</strong>
        </dd>
        {sameSize === null ? null : (
          <p className="metric-note">
            {effectiveN !== null && effectiveN < companies
              ? `Your portfolio is as spread out as ${sameSize} equal-sized companies — not ${formatCount(companies)}, because a few big companies take up more of your money.`
              : `Your portfolio is as spread out as ${sameSize} equal-sized companies.`}
          </p>
        )}
      </li>
      <li>
        <dt>Biggest 10 companies</dt>
        <dd>
          <strong>{top10 === null ? "not computable" : formatShare(top10)}</strong>
        </dd>
        {top10 === null ? null : (
          <p className="metric-note">Their share of your money.</p>
        )}
      </li>
      <li>
        <dt>Concentration</dt>
        <dd>
          <strong>{hhi === null ? "not computable" : formatRatio(hhi, 4)}</strong>
        </dd>
        {hhi === null ? null : (
          <p className="metric-note">0 = spread evenly, 1 = all in one company.</p>
        )}
      </li>
    </ul>
  );
}
