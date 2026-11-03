/**
 * The Companies lens's "Effective holdings" block: the pair of counts, the ladder that
 * places them, and the arithmetic behind them.
 *
 * Three things this block is careful about:
 *
 * 1. **The ladder is a position, not a value you read off an axis.** Core, Broad and the
 *    number of companies are all printed as text on their markers, so nobody has to
 *    interpolate between ticks. Positions are `log(value) / log(N)`: the counts span 1 to
 *    N and most of the portfolio's shape lives in the first tenth of that range, so a
 *    linear strip would draw Core and Broad on top of each other and a 500-company tail
 *    as a flat line at the right. Equal distances are equal ratios.
 *
 * 2. **The labels cannot collide or overflow.** Two markers closer than a label's width
 *    are put on different lanes (above each other), and a marker within one label-width of
 *    either end grows its label inward instead of centred. Both thresholds are set for the
 *    narrowest container the lens renders in — a 320 px window — where a label is about
 *    ​0.3 of the strip; on a wider screen they merely stagger earlier than they must.
 *
 * 3. **Core and Broad are told apart by their words and their places, never by colour.**
 *    The whole block uses the page's own ink, graphite and rule tokens; there is no hue
 *    here for a reader to decode, and nothing that survives only in colour.
 *
 * The evidence layer is the only place the arithmetic's own names (HHI, H) may appear —
 * the site's rule is that a reader meets "here is how it is worked out" deliberately, and
 * never in a label, a header or a summary sentence. Every number there is the unrounded
 * value printed through `lib/format.ts`; nothing is recomputed here.
 *
 * Withheld numbers: below 60% coverage every figure the maths produces is `null`, and this
 * block prints the explanation instead of a zero — the site's rule is that a metric over a
 * minority of the money would describe a different portfolio (`lookthrough-math-and-qa`
 * §5). No ladder, no sentences and no `<details>` in that state, because a disclosure that
 * opens onto nothing is worse than no disclosure.
 */

import type { ReactNode } from "react";

import type { EffectiveHoldings } from "@/lib/effective-holdings";
import {
  coverageLabel,
  formatCount,
  formatCoveragePct,
  formatEffective,
  formatPct1,
  formatRatio,
  formatShare,
} from "@/lib/format";

import styles from "./EffectiveHoldingsSummary.module.css";
import { LensSection } from "./lens-chrome";

/** Companies that fit in a top ten; the sentence below names ten only when there are. */
const TOP = 10;

/**
 * How far apart two markers must be, as a share of the strip, to share a lane.
 *
 * Set at a 320 px window: the strip is about 270 px there and the longest label
 * ("Owned 100,000") about 80 px, so two labels need roughly 0.3 of the width between their
 * centres. A wider strip only staggers labels that had room to sit side by side.
 */
const LANE_GAP = 0.32;

/** Inside this much of either end, a centred label would hang over the edge. */
const EDGE = 0.18;

/** One lane of label, and the room a label needs above the rail. */
const LANE_STEP_REM = 1.5;
const LABEL_ROOM_REM = 1.9;

export interface LadderMarker {
  /** Core, Broad or Owned. */
  label: string;
  /** The marker's own value, already formatted by `formatEffective`/`formatCount`. */
  value: string;
  /** 0 at one company, 1 at N: the share of the strip's width. */
  position: number;
  /** Which way the label grows from the tick, so an end marker cannot overflow. */
  align: "start" | "middle" | "end";
  /** 0 sits on the rail; a close neighbour takes the next lane instead of overlapping. */
  lane: number;
}

/**
 * Place the three markers on the log scale, and give each a lane and an alignment.
 *
 * Pure and exported for the tests: the log rule and the lane rule are the two things a
 * reader cannot check by eye, so they are checked by assertion instead.
 *
 * `N = 1` is the case both rules exist for: `log(1) = 0` leaves no scale at all, so every
 * marker sits at 0 and the lane rule is the only thing keeping three labels apart.
 */
export function ladderMarkers(
  core: number,
  broad: number,
  companies: number,
): LadderMarker[] {
  const top = Math.max(1, companies);
  const span = Math.log(top);
  const place = (value: number): number => {
    if (!(span > 0)) return 0;
    // A count of 1 is the axis's own left end; nothing below it has a position.
    const inside = Math.min(top, Math.max(1, value));
    return Math.min(1, Math.max(0, Math.log(inside) / span));
  };

  const placed = [
    { label: "Core", value: formatEffective(core), position: place(core) },
    { label: "Broad", value: formatEffective(broad), position: place(broad) },
    { label: "Owned", value: formatCount(top), position: place(top) },
  ];

  // The lanes in use, each holding the position of the last marker placed on it. A marker
  // takes the first lane with room, so three markers that coincide take three lanes and
  // two that do not share one.
  const laneEnds: number[] = [];

  return placed.map((marker) => {
    const free = laneEnds.findIndex((end) => marker.position - end >= LANE_GAP);
    let lane = free;
    if (free === -1) {
      laneEnds.push(marker.position);
      lane = laneEnds.length - 1;
    } else {
      laneEnds[lane] = marker.position;
    }

    const align: LadderMarker["align"] =
      marker.position <= EDGE ? "start" : marker.position >= 1 - EDGE ? "end" : "middle";

    return { ...marker, align, lane };
  });
}

/** `2.6 to 2.9` — a range printed through the one count formatter. */
function rangeWords(range: readonly [number, number]): string {
  return `${formatEffective(range[0])} to ${formatEffective(range[1])}`;
}

export function EffectiveHoldingsSummary({
  effective,
}: {
  effective: EffectiveHoldings;
}) {
  const core = effective.core;
  const broad = effective.broad;

  if (effective.band === "none" || core === null || broad === null) {
    return (
      <LensSection title="Effective holdings">
        <p className="small muted">
          Coverage is below 60% of weight ({formatCoveragePct(effective.coveragePct)}), so
          no effective-holdings figure is shown: one computed over the part that resolved
          would describe a different portfolio.
        </p>
      </LensSection>
    );
  }

  const markers = ladderMarkers(core, broad, effective.companies);
  const lanes =
    markers.reduce((deepest, marker) => Math.max(deepest, marker.lane), 0) + 1;
  const stripHeight = `${lanes * LANE_STEP_REM + LABEL_ROOM_REM}rem`;

  const topTen = effective.topTenConcentrationShare;
  const hhi = effective.hhi;
  const entropy = effective.entropy;

  // Every row is pushed only when the maths produced the number, so a withheld figure is
  // absent rather than zero and a missing one cannot render `NaN`.
  const facts: Array<{ label: string; value: ReactNode }> = [
    {
      label: "Core",
      value: (
        <span className="mono">
          1 / Σ s<sub>i</sub>²
        </span>
      ),
    },
    {
      label: "Broad",
      value: (
        <span className="mono">
          exp(Σ −s<sub>i</sub> ln s<sub>i</sub>)
        </span>
      ),
    },
  ];

  if (hhi !== null) {
    facts.push({
      label: "HHI",
      value: `${formatRatio(hhi)} · ${formatCount(Math.round(hhi * 10_000))} points`,
    });
  }
  if (entropy !== null) {
    facts.push({ label: "H", value: `${formatRatio(entropy)} nats` });
  }
  facts.push({
    label: "Broad / Core",
    value: `${formatEffective(broad / core)} · top-heaviness`,
  });
  if (topTen !== null) {
    facts.push({ label: "Top ten, concentration", value: formatPct1(topTen) });
  }
  if (effective.topTenBreadthShare !== null) {
    facts.push({
      label: "Top ten, breadth",
      value: formatPct1(effective.topTenBreadthShare),
    });
  }
  facts.push({ label: "Companies", value: formatCount(effective.companies) });
  facts.push({
    label: "Weight in companies",
    value: formatShare(effective.matchedWeight),
  });
  facts.push({
    label: "Not companies",
    value: `${formatShare(effective.excludedNonCompanyWeight)} (cash and derivatives)`,
  });
  facts.push({
    label: "Unmatched",
    value: `${formatShare(effective.unmatchedWeight)} in ${formatCount(
      effective.unmatchedPositions,
    )} ${effective.unmatchedPositions === 1 ? "position" : "positions"}`,
  });
  facts.push({ label: "Coverage", value: coverageLabel(effective.coveragePct) });
  if (effective.coreRange !== null) {
    facts.push({
      label: "Core, whole portfolio",
      value: rangeWords(effective.coreRange),
    });
  }
  if (effective.broadRange !== null) {
    facts.push({
      label: "Broad, whole portfolio",
      value: rangeWords(effective.broadRange),
    });
  }

  return (
    <LensSection title="Effective holdings">
      <figure className={styles.ladder}>
        {/*
          The strip is the picture; the figcaption is the text. A screen reader gets the
          three numbers once, as a sentence, instead of hearing a label repeated by a
          decorative arrangement of spans.
        */}
        <div className={styles.strip} style={{ height: stripHeight }} aria-hidden="true">
          <span className={styles.rail} />
          {markers.map((marker) => (
            <span
              key={marker.label}
              className={styles.marker}
              data-lane={marker.lane}
              data-align={marker.align}
              style={{ left: `${(marker.position * 100).toFixed(2)}%` }}
            >
              <span className={styles.tick} />
              <span className={styles.label}>
                {marker.label} <strong>{marker.value}</strong>
              </span>
            </span>
          ))}
        </div>
        <figcaption className="visually-hidden">
          On a log scale from 1 to {formatCount(effective.companies)} companies: Core{" "}
          {formatEffective(core)}, Broad {formatEffective(broad)}, and{" "}
          {formatCount(effective.companies)} owned.
        </figcaption>
      </figure>

      {effective.companies > TOP && topTen !== null ? (
        <p>
          The ten largest companies make up <strong>{formatPct1(topTen)}</strong> of the
          concentration behind the core count.
        </p>
      ) : null}

      {effective.coreDisjoint !== null && effective.broadDisjoint !== null ? (
        <p className="small muted">
          Without overlap between your funds: Core{" "}
          <strong>{formatEffective(effective.coreDisjoint)}</strong>, Broad{" "}
          <strong>{formatEffective(effective.broadDisjoint)}</strong>.
        </p>
      ) : null}

      <details className={styles.evidence}>
        <summary>How these numbers are worked out</summary>
        <p className="small muted">
          s<sub>i</sub> is each company&apos;s share of your matched company weight.
        </p>
        <dl className={styles.facts}>
          {facts.map((fact) => (
            <div className={styles.fact} key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
        {/*
          The three weight rows partition the portfolio, but they need not print as 100%:
          a fund's filed positions can total a little over its own NAV, and each fund is
          scaled by its weight in the portfolio, so the parts can run a little over the
          whole. Said once, in words, rather than by nudging a number that is right.
        */}
        <p className={`small muted ${styles.note}`}>
          Each fund&apos;s filed positions can add up to slightly more than its own NAV,
          so these shares need not total 100%.
        </p>
        <p className="small">
          <a href="/methodology/#effective-holdings">
            How effective holdings are defined
          </a>
          . It measures how evenly your money is spread across companies; it ignores how
          companies move together.
        </p>
      </details>
    </LensSection>
  );
}
