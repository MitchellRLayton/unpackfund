"use client";

/**
 * The Companies lens's "Effective holdings" block: one plain-English answer to "how
 * diversified is this portfolio really, compared with what, and why".
 *
 * The block is a rendering of `lib/effective-holdings-view.ts`'s tested object. It prints,
 * in order: the headline (owned companies vs the effective count), the verdict against the
 * selected benchmark, three comparison bars on one linear scale, two key facts, and the
 * arithmetic in a closed disclosure. The concentration curve is a lazy-loaded deeper view
 * behind "See the curve" — its module and d3 imports are not in the first page bundle.
 *
 * Rules the markup keeps:
 * - **No jargon outside the disclosure.** The block says "effective number" and "lenient
 *   count"; the arithmetic's own names (HHI, entropy) live only in the disclosure.
 * - **Every bar is labelled and numbered.** Colour is reinforcement, never the carrier.
 * - **A missing benchmark removes the comparison, not the block.** The You bar and the
 *   headline stay; the verdict and the benchmark bar are absent rather than zero.
 * - **Withheld numbers stay withheld.** Below 60% coverage the maths produces `null` and
 *   the block prints the explanation instead of a figure.
 */

import { useEffect, useMemo, useState, type ComponentType } from "react";

import type { EffectiveHoldings } from "@/lib/effective-holdings";
import {
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
  const view = useMemo(
    () => buildEffectiveHoldingsView({ effective, rows, benchmark, fundCount, directCount }),
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
    const entries = Object.entries(benchmark.weights ?? {}).filter(([, weight]) => weight > 0);
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
      <LensSection title="Effective holdings">
        <p className="small muted">
          Coverage is below 60% of weight ({formatShare(effective.coveragePct / 100)}), so
          no effective-holdings figure is shown: one computed over the part that resolved
          would describe a different portfolio.
        </p>
      </LensSection>
    );
  }

  const bars: Array<{ key: string; label: string; value: number; tone: "you" | "neutral" }> = [
    { key: "you", label: "You", value: view.effective, tone: "you" },
  ];
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
    <LensSection title="Effective holdings">
      <p className={styles.headline}>{view.headline}</p>
      {view.verdict ? <p className={styles.verdict}>{view.verdict}</p> : null}

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
              <span className={`${styles.barValue} mono`}>{effectiveWords(bar.value)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {!view.singleStock ? (
        <ul className={styles.bullets}>
          {view.top10WeightPct !== null && view.top1 ? (
            <li>
              Your 10 largest companies are {formatPct1(view.top10WeightPct / 100)} of your
              money. {view.top1.name} alone is {formatPct1(view.top1.weightPct / 100)}.
            </li>
          ) : null}
          {view.singleFund ? null : view.noShared ? (
            <li>
              Your funds don&apos;t share any companies, so overlap isn&apos;t reducing your
              diversification.
            </li>
          ) : view.worstOverlap && view.noOverlapEffective !== null ? (
            <li>
              Overlap is the biggest reason. Your {formatCount(view.fundCount)} funds share
              their largest names ({view.worstOverlap.name} is in{" "}
              {formatCount(view.worstOverlap.heldBy)} of {formatCount(view.fundCount)}).
              Without that overlap you&apos;d have the diversification of{" "}
              {effectiveWords(view.noOverlapEffective)} companies instead of{" "}
              {effectiveWords(view.effective)}.{" "}
              <button type="button" className={styles.inlineLink} onClick={onSeeOverlap}>
                See Overlap →
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}

      {!view.singleStock ? (
        <details className={styles.details}>
          <summary>How this is calculated</summary>
          <p>
            <strong>Effective number of companies ({effectiveWords(view.effective)})</strong>{" "}
            = 1 ÷ Σ(weight²), using each company&apos;s combined weight across all your
            funds. It&apos;s the number of equally weighted companies that would give the
            same concentration. Example: two stocks at 50/50 → 2.0. At 90/10 → 1.2.
          </p>
          <p>
            <strong>Lenient count ({effectiveWords(view.lenient ?? 0)})</strong> = e^(entropy
            of your weights). It gives more credit to the long tail of small positions, so
            it&apos;s always between the effective number and the number of companies you
            own.
          </p>
          <p>
            <strong>
              Without overlap ({effectiveWords(view.noOverlapEffective ?? 0)}; lenient{" "}
              {effectiveWords(view.noOverlapLenient ?? 0)})
            </strong>
            : the same calculations if every fund&apos;s positions were separate companies.
            The gap from {effectiveWords(view.effective)} is how much diversification overlap
            costs you ({view.overlapCostPct ?? 0}%).
          </p>
          <p>
            <strong>Top-10 concentration</strong>: your 10 largest companies are{" "}
            {view.top10WeightPct === null ? "—" : formatPct1(view.top10WeightPct / 100)} of
            your money and account for{" "}
            {view.top10HhiSharePct === null ? "—" : formatPct1(view.top10HhiSharePct / 100)}{" "}
            of the effective-number calculation.
          </p>
          <p className={styles.note}>
            Weights are normalized to the{" "}
            {view.coveredPct === null ? "covered" : formatShare(view.coveredPct / 100)} of
            your portfolio that filings can place. Holdings as of each fund&apos;s latest
            public filing.
          </p>
        </details>
      ) : null}

      <details
        className={styles.curve}
        onToggle={(event) => setCurveOpen(event.currentTarget.open)}
      >
        <summary>See the curve</summary>
        {curveOpen ? (
          Curve ? (
            <Curve you={curveYou} benchmark={curveBenchmark} />
          ) : (
            <p className="small muted">Loading the chart…</p>
          )
        ) : null}
      </details>
    </LensSection>
  );
}
