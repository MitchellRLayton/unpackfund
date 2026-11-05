"use client";

import { TIER_AS_OF } from "@/lib/country-tier";
import { formatShare } from "@/lib/format";

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
  { key: "us", label: "United States", segment: "bar__seg--us" },
  { key: "dm", label: "International Developed ex-US", segment: "bar__seg--dm" },
  { key: "em", label: "Emerging Markets", segment: "bar__seg--em" },
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
export function MarketSplitChart({ a, b }: { a: MarketSplit; b: MarketSplit }) {
  const unplacedA = Math.max(0, a.unplaced);
  const unplacedB = Math.max(0, b.unplaced);

  return (
    <section className="stack stack--tight" aria-labelledby="markets-heading">
      <h2 id="markets-heading" className="eyebrow">
        Where the two mixes sit
      </h2>
      <p className="small muted">
        Both bars are on one scale — 0 to 100% of the weight each mix can place — so their
        lengths can be read against each other.
      </p>

      <div className="panel">
        <div className="panel__head">
          <h3 className="panel__title">Market split</h3>
          <span className="chip chip--date">{TIER_AS_OF}</span>
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
                {tier.label}
              </span>
            ))}
          </div>

          <div className="table-wrap">
            <table className="table">
              <caption>
                Each company is placed by the market its domicile belongs to, using the
                FTSE Russell equity country classification as of {TIER_AS_OF}. An offshore
                holding domicile such as Bermuda or the Cayman Islands is the United
                States, because that is where its shares trade. Outside the bar:{" "}
                {formatShare(unplacedA)} of Mix A and {formatShare(unplacedB)} of Mix B is
                weight the classification could not place — a company whose holders&rsquo;
                filings do not agree on a country, or weight that could not be traced to a
                company at all. Shares are rounded to two places and may not visibly add
                up.
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
                    <th scope="row">{tier.label}</th>
                    <td className="num">{formatShare(a[tier.key])}</td>
                    <td className="num">{formatShare(b[tier.key])}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Everything the bar draws</th>
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
          (tier) => `${formatShare(split[tier.key])} ${tier.label}`,
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
