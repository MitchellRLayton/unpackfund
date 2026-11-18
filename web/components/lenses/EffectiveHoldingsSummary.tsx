"use client";

/**
 * The Companies lens's "Effective holdings" block: one plain-English answer to "how
 * diversified is this portfolio really, compared with what, and why".
 *
 * The block is a rendering of `lib/effective-holdings-view.ts`'s tested object. It prints,
 * in order: the headline (owned companies vs the effective count), the verdict against the
 * selected benchmark, three comparison bars on one linear scale, the overlap finding, the
 * four figures the old arithmetic disclosure carried, and a link to the method. The
 * concentration curve is a lazy-loaded deeper view behind "See the curve" — its module and
 * d3 imports are not in the first page bundle.
 *
 * Rules the markup keeps:
 * - **No jargon.** The block says "effective holdings", "Core" and "Broad"; the
 *   arithmetic's own names (HHI, entropy) are not printed at all — the method is the
 *   methodology page's `#effective-holdings`, one link away (P-C-05, OD-03 B).
 * - **Every bar is labelled and numbered.** Colour is reinforcement, never the carrier.
 * - **A missing benchmark removes the comparison, not the block.** The You bar and the
 *   headline stay; the verdict and the benchmark bar are absent rather than zero.
 * - **Withheld numbers stay withheld.** Below 60% coverage the maths produces `null` and
 *   the block prints the explanation instead of a figure.
 */

import { useEffect, useMemo, useState, type ComponentType } from "react";

import { Term } from "@/components/prose/Term";
import type { EffectiveHoldings } from "@/lib/effective-holdings";
import {
  bandFor,
  buildEffectiveHoldingsView,
  effectiveWords,
} from "@/lib/effective-holdings-view";
import { formatCount, formatPct1, formatShare } from "@/lib/format";
import type { BenchmarkComparison, LedgerRow } from "@/lib/types";

import type { CurveProps } from "./ConcentrationCurve";
import styles from "./EffectiveHoldingsSummary.module.css";
import { LensSection } from "./lens-chrome";

export function EffectiveHoldingsSummary({
  effective,
  rows,
  benchmark,
  fundCount,
  directCount,
  onSeeOverlap,
}: {
  effective: EffectiveHoldings;
  rows: readonly LedgerRow[];
  benchmark: BenchmarkComparison | null;
  fundCount: number;
  directCount: number;
  onSeeOverlap: () => void;
}) {
  /** The hover tooltip on the risk band: what the colour does and does not measure. */
  const RISK_TOOLTIP =
    "Single-company risk measures how evenly your money is spread across individual companies. It ignores correlation — 100 semiconductor stocks can score Diversified and still be one sector bet.";

  const view = useMemo(
    () =>
      buildEffectiveHoldingsView({ effective, rows, benchmark, fundCount, directCount }),
    [effective, rows, benchmark, fundCount, directCount],
  );

  // The curve module is loaded only when the expander opens.
  const [Curve, setCurve] = useState<ComponentType<CurveProps> | null>(null);
  const [curveOpen, setCurveOpen] = useState(false);
  useEffect(() => {
    if (!curveOpen || Curve) return;
    let cancelled = false;
    import("./ConcentrationCurve").then((module) => {
      if (!cancelled) setCurve(() => module.ConcentrationCurve);
    });
    return () => {
      cancelled = true;
    };
  }, [curveOpen, Curve]);

  // Company-level weights normalised to 1 over the matched total, and the benchmark's own
  // weights normalised to its traced total — the same rule the effective counts use.
  const curveYou = useMemo<CurveProps["you"]>(() => {
    const total = rows.reduce((sum, row) => sum + row.weight, 0);
    if (total <= 0) return [];
    return rows.map((row) => ({
      name: row.name,
      ticker: row.ticker,
      weight: row.weight / total,
    }));
  }, [rows]);
  const curveBenchmark = useMemo<CurveProps["benchmark"]>(() => {
    if (!benchmark) return null;
    const entries = Object.entries(benchmark.weights ?? {}).filter(
      ([, weight]) => weight > 0,
    );
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    if (total <= 0) return null;
    return {
      ticker: benchmark.ticker,
      weights: entries.map(([companyId, weight]) => ({
        name: companyId,
        ticker: null,
        weight: weight / total,
      })),
    };
  }, [benchmark]);

  if (effective.band === "none" || view.effective === null) {
    return (
      <LensSection title={<Term name="effective-holdings">Effective holdings</Term>}>
        <p className="small muted">
          Coverage is below 60% of weight ({formatShare(effective.coveragePct / 100)}), so
          no effective-holdings figure is shown: one computed over the part that resolved
          would describe a different portfolio.
        </p>
      </LensSection>
    );
  }

  const bars: Array<{
    key: string;
    label: string;
    value: number;
    tone: "you" | "neutral";
  }> = [{ key: "you", label: "You", value: view.effective, tone: "you" }];
  if (view.benchmark) {
    bars.push({
      key: "benchmark",
      label: view.benchmark.ticker,
      value: view.benchmark.effective,
      tone: "neutral",
    });
  }
  if (!view.singleFund && !view.noShared && view.noOverlapEffective !== null) {
    bars.push({
      key: "no-overlap",
      label: "Your funds, if they didn't overlap",
      value: view.noOverlapEffective,
      tone: "neutral",
    });
  }
  const max = Math.max(...bars.map((bar) => bar.value)) * 1.1;

  return (
    <LensSection title={<Term name="effective-holdings">Effective holdings</Term>}>
      <p className={styles.headline}>{view.headline}</p>
      {view.band ? (
        <p className={styles.riskLine}>
          <span
            className={styles.riskDot}
            data-band={view.band.key}
            aria-hidden="true"
            title={RISK_TOOLTIP}
          />
          <span className={styles.riskText}>
            <span className={styles.riskTitle} title={RISK_TOOLTIP}>
              Single-company risk
            </span>
            {" · "}
            <strong>
              {view.band.colour} · {view.band.label}
            </strong>
            {view.verdict ? <> — {view.verdict}</> : null}
          </span>
        </p>
      ) : null}

      {!view.singleStock ? (
        <ul className={styles.bars} aria-label="Effective number of companies, compared">
          {bars.map((bar) => (
            <li
              key={bar.key}
              className={styles.barRow}
              aria-label={`${bar.label}: ${effectiveWords(bar.value)} effective companies`}
            >
              <span className={styles.barLabel}>{bar.label}</span>
              <span className={styles.track} aria-hidden="true">
                <span
                  className={`${styles.fill} ${bar.tone === "you" ? styles.you : styles.neutral}`}
                  style={{ width: `${(bar.value / max) * 100}%` }}
                />
              </span>
              <span className={`${styles.barValue} mono`}>
                {effectiveWords(bar.value)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {!view.singleStock ? (
        <ul className={styles.bullets}>
          {view.singleFund ? null : view.noShared ? (
            <li>
              Your funds don&apos;t share any companies, so overlap isn&apos;t reducing
              your diversification.
            </li>
          ) : view.worstOverlap && view.noOverlapEffective !== null ? (
            <li>
              Overlap is the main cause: {view.worstOverlap.name} is in{" "}
              {formatCount(view.worstOverlap.heldBy)} of your{" "}
              {formatCount(view.fundCount)} funds.{" "}
              <button type="button" className={styles.inlineLink} onClick={onSeeOverlap}>
                See Overlap →
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}

      {/*
        P-C-05, on the owner's decision OD-03 option B: the seven-paragraph arithmetic
        disclosure becomes a link to the method, and the four per-portfolio figures it
        carried stay on screen. The research the risk bands lean on is at that anchor
        (MA-01), not repeated here. Each figure prints only when it exists — a missing
        count is absent, never a zero.
      */}
      {!view.singleStock ? (
        <div className={styles.method}>
          <a className={styles.inlineLink} href="/methodology/#effective-holdings">
            How this is calculated
          </a>
          {view.noOverlapEffective !== null &&
          view.noOverlapLenient !== null &&
          view.overlapCostPct !== null &&
          view.top10HhiSharePct !== null ? (
            <p className="small muted">
              Without overlap: Core {effectiveWords(view.noOverlapEffective)}, Broad{" "}
              {effectiveWords(view.noOverlapLenient)} · overlap costs{" "}
              {view.overlapCostPct}% of Core · top 10 drive{" "}
              {formatPct1(view.top10HhiSharePct / 100)} of Core
            </p>
          ) : null}
        </div>
      ) : null}

      <details
        className={styles.curve}
        onToggle={(event) => setCurveOpen(event.currentTarget.open)}
      >
        <summary>See the curve</summary>
        {curveOpen ? (
          Curve ? (
            <Curve
              you={curveYou}
              benchmark={curveBenchmark}
              band={view.band ?? bandFor(view.effective)}
              benchmarkBand={view.benchmark ? bandFor(view.benchmark.effective) : null}
              effective={view.effective}
            />
          ) : (
            <p className="small muted">Loading the chart…</p>
          )
        ) : null}
      </details>
    </LensSection>
  );
}
