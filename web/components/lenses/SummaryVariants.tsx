"use client";

/**
 * PROTOTYPE — branch prototype/results-summary. Never merged.
 *
 * Q: Which layout makes the results summary above "Your companies" (top-10 line,
 * effective holdings, single-company risk, the You/VT/no-overlap bars, the overlap cause,
 * the method line) quick to read instead of a stack of sentences?
 *
 * Three variants on the real page with real data, switched by `?variant=a|b|c`. They
 * differ in structure and hierarchy, not in colour or copy. In every variant the date
 * note and the filter box move down onto the table they belong to.
 */

import { useMemo, useSyncExternalStore } from "react";

import {
  buildEffectiveHoldingsView,
  effectiveWords,
} from "@/lib/effective-holdings-view";
import { formatCount, formatPct1, formatShare } from "@/lib/format";
import type { BenchmarkComparison, Ledger } from "@/lib/types";

import ehs from "./EffectiveHoldingsSummary.module.css";
import styles from "./SummaryVariants.module.css";

export type SummaryVariant = "a" | "b" | "c";

const QUESTIONS: Record<SummaryVariant, string> = {
  a: "Stat cards: three numbers first, the reasoning one click away",
  b: "One sentence and one chart, everything else folded",
  c: "Question rows: each line asks and answers, opens for detail",
};

function readVariant(): SummaryVariant | null {
  const value = new URLSearchParams(window.location.search).get("variant");
  return value === "a" || value === "b" || value === "c" ? value : null;
}

/** The variant in the address bar, or null for the current design. */
export function useSummaryVariant(): SummaryVariant | null {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener("popstate", listener);
      return () => window.removeEventListener("popstate", listener);
    },
    readVariant,
    () => null,
  );
}

/** The floating switcher. A control, not decoration: it names what each variant tests. */
export function VariantBar() {
  const current = useSummaryVariant();
  const href = (variant: SummaryVariant | null) => {
    const params = new URLSearchParams(
      typeof window === "undefined" ? "" : window.location.search,
    );
    if (variant) params.set("variant", variant);
    else params.delete("variant");
    const query = params.toString();
    return `${query ? `?${query}` : "?"}${typeof window === "undefined" ? "" : window.location.hash}`;
  };
  return (
    <nav className={styles.variantBar} aria-label="Prototype variants">
      <span className={styles.variantTitle}>Prototype · results summary</span>
      {([null, "a", "b", "c"] as const).map((variant) => (
        <a
          key={variant ?? "current"}
          href={href(variant)}
          className={styles.variantLink}
          aria-current={current === variant ? "true" : undefined}
          title={variant ? QUESTIONS[variant] : "What ships today"}
        >
          {variant ? variant.toUpperCase() : "Current"}
        </a>
      ))}
      <span className={styles.variantQuestion}>
        {current ? QUESTIONS[current] : "What ships today"}
      </span>
    </nav>
  );
}

interface Props {
  variant: SummaryVariant;
  ledger: Ledger;
  benchmark: BenchmarkComparison | null;
  fundCount: number;
  directCount: number;
  onSeeOverlap: () => void;
}

export function SummaryVariants(props: Props) {
  const { variant, ledger, benchmark, fundCount, directCount } = props;
  const view = useMemo(
    () =>
      buildEffectiveHoldingsView({
        effective: ledger.effective,
        rows: ledger.rows,
        benchmark,
        fundCount,
        directCount,
      }),
    [ledger, benchmark, fundCount, directCount],
  );
  // Throwaway arithmetic for the prototype: the shipped `topTenFact` owns this for real.
  const top = useMemo(() => {
    const sorted = [...ledger.rows].sort((a, b) => b.weight - a.weight);
    const total = sorted.reduce((sum, row) => sum + row.weight, 0);
    const ten = sorted.slice(0, 10).reduce((sum, row) => sum + row.weight, 0);
    return { share: total > 0 ? ten / total : 0, largest: sorted[0] ?? null };
  }, [ledger.rows]);

  if (view.effective === null) return null;

  const owned = ledger.rows.length;
  const bars = [
    { key: "you", label: "You", value: view.effective, you: true },
    ...(view.benchmark
      ? [
          {
            key: "bm",
            label: view.benchmark.ticker,
            value: view.benchmark.effective,
            you: false,
          },
        ]
      : []),
    ...(!view.singleFund && !view.noShared && view.noOverlapEffective !== null
      ? [
          {
            key: "no",
            label: "If your funds didn't overlap",
            value: view.noOverlapEffective,
            you: false,
          },
        ]
      : []),
  ];
  const max = Math.max(...bars.map((bar) => bar.value)) * 1.05;

  const risk = view.band ? (
    <span className={styles.risk}>
      <span className={ehs.riskDot} data-band={view.band.key} aria-hidden="true" />
      <strong>{view.band.colour}</strong> · {view.band.label}
    </span>
  ) : null;

  const barList = (
    <ul className={styles.bars}>
      {bars.map((bar) => (
        <li key={bar.key} className={styles.barRow}>
          <span className={styles.barLabel}>{bar.label}</span>
          <span className={styles.track} aria-hidden="true">
            <span
              className={`${styles.fill} ${bar.you ? styles.fillYou : ""}`}
              style={{ width: `${(bar.value / max) * 100}%` }}
            />
          </span>
          <span className={styles.barValue}>{effectiveWords(bar.value)}</span>
        </li>
      ))}
    </ul>
  );

  const overlapCause =
    view.worstOverlap && !view.noShared && !view.singleFund ? (
      <>
        {view.worstOverlap.name} is in {formatCount(view.worstOverlap.heldBy)} of your{" "}
        {formatCount(view.fundCount)} funds.{" "}
        <button type="button" className={styles.link} onClick={props.onSeeOverlap}>
          See Overlap →
        </button>
      </>
    ) : null;

  const method =
    view.overlapCostPct !== null && view.top10HhiSharePct !== null ? (
      <p className={styles.method}>
        Overlap costs {view.overlapCostPct}% of Core · top 10 drive{" "}
        {formatPct1(view.top10HhiSharePct / 100)} of Core ·{" "}
        <a className={styles.link} href="/methodology/#effective-holdings">
          How this is calculated
        </a>
      </p>
    ) : null;

  if (variant === "a") {
    return (
      <section className={styles.cardsWrap} aria-label="Summary">
        <div className={styles.cards}>
          <div className={styles.card}>
            <span className={styles.cardLabel}>Behaves like</span>
            <span className={styles.cardValue}>{effectiveWords(view.effective)}</span>
            <span className={styles.cardSub}>
              equal companies · you own {formatCount(owned)}
              {view.benchmark
                ? ` · ${view.benchmark.ticker} ${effectiveWords(view.benchmark.effective)}`
                : ""}
            </span>
          </div>
          <div className={styles.card}>
            <span className={styles.cardLabel}>Top 10 companies</span>
            <span className={styles.cardValue}>{formatPct1(top.share)}</span>
            <span className={styles.cardSub}>
              of the mix · largest {top.largest?.name}{" "}
              {top.largest ? formatShare(top.largest.weight) : ""}
            </span>
          </div>
          <div className={styles.card}>
            <span className={styles.cardLabel}>Single-company risk</span>
            <span className={styles.cardValue}>
              {view.band ? (
                <span className={styles.risk}>
                  <span
                    className={ehs.riskDot}
                    data-band={view.band.key}
                    aria-hidden="true"
                  />
                  {view.band.colour}
                </span>
              ) : null}
            </span>
            <span className={styles.cardSub}>
              {view.band?.label} · {view.verdict}
            </span>
          </div>
        </div>
        <details className={styles.more}>
          <summary>Why these numbers?</summary>
          {barList}
          {overlapCause ? (
            <p className={styles.line}>Main cause: {overlapCause}</p>
          ) : null}
          {method}
        </details>
      </section>
    );
  }

  if (variant === "b") {
    return (
      <section className={styles.chartWrap} aria-label="Summary">
        <p className={styles.headline}>
          Your {formatCount(owned)} companies behave like{" "}
          <strong>{effectiveWords(view.effective)}</strong>.
        </p>
        {barList}
        <ul className={styles.chips}>
          {risk ? <li className={styles.chip}>{risk}</li> : null}
          <li className={styles.chip}>
            Top 10 · <strong>{formatPct1(top.share)}</strong>
          </li>
          {view.worstOverlap && !view.noShared && !view.singleFund ? (
            <li className={styles.chip}>
              <button type="button" className={styles.link} onClick={props.onSeeOverlap}>
                Overlap: {view.worstOverlap.name} in{" "}
                {formatCount(view.worstOverlap.heldBy)} funds →
              </button>
            </li>
          ) : null}
        </ul>
        <details className={styles.more}>
          <summary>Details</summary>
          {view.verdict ? <p className={styles.line}>{view.verdict}</p> : null}
          {top.largest ? (
            <p className={styles.line}>
              Largest company: {top.largest.name} {formatShare(top.largest.weight)}
            </p>
          ) : null}
          {method}
        </details>
      </section>
    );
  }

  // Variant C: question rows.
  return (
    <section className={styles.rows} aria-label="Summary">
      <details className={styles.row}>
        <summary className={styles.rowHead}>
          <span className={styles.rowQ}>How spread out is my money?</span>
          <span className={styles.rowA}>
            Like <strong>{effectiveWords(view.effective)}</strong> equal companies
            {view.benchmark
              ? ` (${view.benchmark.ticker}: ${effectiveWords(view.benchmark.effective)})`
              : ""}
          </span>
        </summary>
        <div className={styles.rowBody}>
          {barList}
          {method}
        </div>
      </details>
      <details className={styles.row}>
        <summary className={styles.rowHead}>
          <span className={styles.rowQ}>Could one company hurt me?</span>
          <span className={styles.rowA}>{risk}</span>
        </summary>
        <div className={styles.rowBody}>
          <p className={styles.line}>{view.verdict}</p>
        </div>
      </details>
      <details className={styles.row}>
        <summary className={styles.rowHead}>
          <span className={styles.rowQ}>How top-heavy is it?</span>
          <span className={styles.rowA}>
            Top 10 = <strong>{formatPct1(top.share)}</strong>
          </span>
        </summary>
        <div className={styles.rowBody}>
          <p className={styles.line}>
            Largest: {top.largest?.name}{" "}
            {top.largest ? formatShare(top.largest.weight) : ""}
          </p>
        </div>
      </details>
      {overlapCause ? (
        <details className={styles.row}>
          <summary className={styles.rowHead}>
            <span className={styles.rowQ}>What is holding it back?</span>
            <span className={styles.rowA}>Overlap between your funds</span>
          </summary>
          <div className={styles.rowBody}>
            <p className={styles.line}>{overlapCause}</p>
          </div>
        </details>
      ) : null}
    </section>
  );
}
