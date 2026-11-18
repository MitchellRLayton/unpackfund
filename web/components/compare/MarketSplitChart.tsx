"use client";

import { TIER_AS_OF, type Provider } from "@/lib/country-tier";
import { formatDateLong, formatShare } from "@/lib/format";

import { InfoTip } from "@/components/feedback/InfoTip";
import { MARKET_LONG, PROVIDER_SHORT } from "@/components/lenses/lens-math";

import styles from "./compare.module.css";
import type { MarketSplit } from "./result";

/**
 * The three markets, in the order the bar draws them.
 *
 * Three, not four: "not placed" is a question the page could not answer rather than an
 * answer, so it is stated in the caption with its own number instead of drawn as a
 * segment (operator's instruction, 2026-11-05). The same three words the Markets lens
 * uses, so a reader who meets a mix on both pages does not learn two names for one tier.
 */
const TIERS = [
  { key: "us", bucket: "US", segment: "bar__seg--us" },
  { key: "dm", bucket: "DM", segment: "bar__seg--dm" },
  { key: "em", bucket: "EM", segment: "bar__seg--em" },
] as const;

/** The weight the bar draws: everything the classification could place. */
function placed(split: MarketSplit): number {
  return Math.max(0, 1 - split.unplaced);
}

/**
 * The two mixes' market splits on one scale.
 *
 * One scale is the whole feature: two bars on their own axes would each fill their
 * width and invite a comparison that is not there. Both bars are 0–100% of the weight
 * their mix can place and share the same pixel width, so 40% of Mix A and 40% of Mix B
 * are the same length, and a reader can see which mix leans where without reading a
 * number.
 *
 * Colour is a market tier and nothing else, and it never carries the answer alone:
 * every segment has a printed weight in the table underneath, the legend names the
 * three tiers, and the bar's own `aria-label` reads the percentages out loud.
 */
export function MarketSplitChart({
  a,
  b,
  provider,
}: {
  a: MarketSplit;
  b: MarketSplit;
  /** The convention both bars were placed under, named in the legend and the caption. */
  provider: Provider;
}) {
  const unplacedA = Math.max(0, a.unplaced);
  const unplacedB = Math.max(0, b.unplaced);

  return (
    <section className="stack stack--tight" aria-labelledby="markets-heading">
      <h2 id="markets-heading" className="eyebrow">
        Markets
      </h2>

      <div className="panel">
        <div className="panel__head">
          <h3 className="panel__title">Market split</h3>
          {/* OD-04: the convention is named once, here, so no label below repeats it. */}
          <span className="chip chip--date" data-convention={provider}>
            {PROVIDER_SHORT[provider]} · {formatDateLong(TIER_AS_OF)}
            <InfoTip label="Country classification">
              Country classification version.
            </InfoTip>
          </span>
        </div>
        <div className="panel__body stack">
          <div className={styles.bars}>
            <Bar label="Mix A" split={a} />
            <Bar label="Mix B" split={b} />
            <div className={styles.scaleRow} aria-hidden="true">
              <span />
              <div className={styles.barScale}>
                <span>0%</span>
                <span>50%</span>
                <span>100%</span>
              </div>
            </div>
          </div>

          <div className="legend">
            {TIERS.map((tier) => (
              <span key={tier.key} className="legend__item">
                <span className={`legend__swatch ${tier.segment}`} aria-hidden="true" />
                {tier.bucket}
                <InfoTip label={tier.bucket}>{MARKET_LONG[tier.bucket]}</InfoTip>
              </span>
            ))}
          </div>

          {/* CN_COMPARE_OUTSIDE, directly under the bars it qualifies. */}
          {unplacedA > 0 || unplacedB > 0 ? (
            <p className="small muted">
              Not in the bars: Mix A {formatShare(unplacedA)}, Mix B{" "}
              {formatShare(unplacedB)} (no agreed country, or not traced).
            </p>
          ) : null}

          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">
                Each mix by market, as a share of its weight.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Market</th>
                  <th scope="col" className="num">
                    Mix A
                  </th>
                  <th scope="col" className="num">
                    Mix B
                  </th>
                </tr>
              </thead>
              <tbody>
                {TIERS.map((tier) => (
                  <tr key={tier.key}>
                    <th scope="row">{tier.bucket}</th>
                    <td className="num">{formatShare(a[tier.key])}</td>
                    <td className="num">{formatShare(b[tier.key])}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total placed</th>
                  <td className="num">{formatShare(placed(a))}</td>
                  <td className="num">{formatShare(placed(b))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}

function Bar({ label, split }: { label: string; split: MarketSplit }) {
  const total = placed(split);
  return (
    <div className={styles.barRow}>
      <span className={styles.barLabel}>{label}</span>
      <div
        className="bar bar--tall"
        role="img"
        aria-label={`${label}: ${TIERS.map(
          (tier) => `${formatShare(split[tier.key])} ${MARKET_LONG[tier.bucket]}`,
        ).join(", ")}`}
      >
        {TIERS.map((tier) => (
          <span
            key={tier.key}
            className={`bar__seg ${tier.segment}`}
            style={{
              width: `${total > 0 ? (Math.max(0, split[tier.key]) / total) * 100 : 0}%`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
