"use client";

/**
 * PROTOTYPE — the effective-holdings redesign. Throwaway; never merged.
 *
 * Q: which layout makes "you own 766 companies and behave like 45" answerable at a glance,
 *    and which one makes the overlap story the thing a reader notices?
 *
 * Switch: ?variant=a|b|c, and ?scenario=example|single|twofunds|onestock|cash for the
 * edge cases the plan requires. Real data: the live release, through the app's own
 * loaders. The prototype seeds the portfolio fragment for the chosen scenario; that is
 * the only thing it writes.
 */

import { useEffect, useMemo, useState } from "react";

import { BENCHMARK_CHOICES } from "@/lib/benchmark";
import { useBenchmarkPreference } from "@/lib/benchmark-preference";
import { equalWeights } from "@/lib/fragment";
import { write } from "@/lib/fragment-store";
import { formatCount, formatPct1, formatShare } from "@/lib/format";
import { CASH_KEY, type PortfolioEntry } from "@/lib/types";
import { useWorkspace, type WorkspaceModel } from "@/lib/use-workspace";

import styles from "./prototype.module.css";

type Variant = "a" | "b" | "c";
type Scenario = "example" | "single" | "twofunds" | "onestock" | "cash";

const VARIANTS: Array<{ id: Variant; name: string; question: string }> = [
  {
    id: "a",
    name: "A · the plan, literally",
    question: "Does the plan's own order read on its own?",
  },
  {
    id: "b",
    name: "B · the number first",
    question: "Is the effective count the headline, with the comparison beside it?",
  },
  {
    id: "c",
    name: "C · the comparison first",
    question: "Does leading with the three bars make the benchmark and overlap obvious?",
  },
];

const SCENARIOS: Record<Scenario, PortfolioEntry[]> = {
  example: equalWeights(["QQQ", "VOO", "SMH", "VGT", "RSPT", "ARKK", "ALAI"]),
  single: equalWeights(["VOO"]),
  twofunds: equalWeights(["VOO", "IEMG"]),
  onestock: [{ kind: "security", key: "AAPL", amount: 10_000 }],
  cash: [{ kind: "cash", key: CASH_KEY, amount: 10_000 }],
};

const SCENARIO_LABEL: Record<Scenario, string> = {
  example: "7 funds (the screenshot portfolio)",
  single: "one fund",
  twofunds: "two funds",
  onestock: "one stock",
  cash: "cash only",
};

function isVariant(value: string | null): value is Variant {
  return value === "a" || value === "b" || value === "c";
}

function isScenario(value: string | null): value is Scenario {
  return value !== null && value in SCENARIOS;
}

function readParams(): { variant: Variant; scenario: Scenario } {
  const params = new URLSearchParams(window.location.search);
  const variant = params.get("variant");
  const scenario = params.get("scenario");
  return {
    variant: isVariant(variant) ? variant : "a",
    scenario: isScenario(scenario) ? scenario : "example",
  };
}

function sameEntries(a: readonly PortfolioEntry[], b: readonly PortfolioEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (entry, index) =>
      entry.kind === b[index]?.kind &&
      entry.key === b[index]?.key &&
      entry.amount === b[index]?.amount,
  );
}

/** One decimal below 1.5 (two companies split almost evenly), an integer otherwise. */
function effectiveWords(value: number): string {
  return value < 1.5 ? value.toFixed(1) : formatCount(Math.round(value));
}

function verdictLine(ratio: number | null, ticker: string): string | null {
  if (ratio === null) return null;
  if (ratio >= 1.15) return `About ${ratio.toFixed(1)}× more concentrated than ${ticker}.`;
  if (ratio <= 0.87) return `About ${(1 / ratio).toFixed(1)}× more diversified than ${ticker}.`;
  return `About as diversified as ${ticker}.`;
}

interface View {
  empty: boolean;
  singleStock: boolean;
  singleFund: boolean;
  noShared: boolean;
  owned: number;
  effective: number | null;
  lenient: number | null;
  noOverlap: number | null;
  noOverlapLenient: number | null;
  overlapCostPct: number | null;
  top10WeightPct: number | null;
  top10HhiSharePct: number | null;
  top1: { name: string; ticker: string | null; weightPct: number } | null;
  worst: { name: string; heldBy: number } | null;
  fundCount: number;
  coveredPct: number | null;
  benchmark: { ticker: string; effective: number } | null;
  ratio: number | null;
  benchmarkMissing: boolean;
}

function buildView(model: WorkspaceModel): View {
  const ledger = model.ledger;
  const effective = ledger?.effective ?? null;
  const rows = ledger?.rows ?? [];
  const funds = Object.keys(model.split.fundWeights).filter(
    (ticker) => (model.split.fundWeights[ticker] ?? 0) > 0,
  );

  const ranked = [...rows].sort((a, b) => b.weight - a.weight);
  const top10 = ranked.slice(0, 10);
  const top1 = top10[0] ?? null;
  const worstRow = [...rows].sort(
    (a, b) => b.holder_count - a.holder_count || b.weight - a.weight,
  )[0];

  // The benchmark's own effective count: the same 1/HHI over its company weights,
  // normalised to its traced total (its weights are shares of its own NAV, summing to
  // slightly less than 1 because some filed weight resolves to no company).
  const benchmark = (() => {
    if (!model.benchmark) return null;
    const weights = Object.values(model.benchmark.weights).filter((value) => value > 0);
    const total = weights.reduce((sum, value) => sum + value, 0);
    if (total <= 0) return null;
    const hhi = weights.reduce((sum, value) => sum + (value / total) ** 2, 0);
    return { ticker: model.benchmark.ticker, effective: 1 / hhi };
  })();

  const core = effective?.core ?? null;
  return {
    empty: rows.length === 0,
    singleStock: rows.length === 1 && funds.length === 0 && model.split.direct.length === 1,
    singleFund: funds.length === 1,
    noShared: funds.length > 1 && (worstRow?.holder_count ?? 0) < 2,
    owned: effective?.companies ?? 0,
    effective: core,
    lenient: effective?.broad ?? null,
    noOverlap: effective?.coreDisjoint ?? null,
    noOverlapLenient: effective?.broadDisjoint ?? null,
    overlapCostPct:
      core !== null && effective?.coreDisjoint ? Math.round((1 - core / effective.coreDisjoint) * 100) : null,
    top10WeightPct: rows.length > 0 ? top10.reduce((sum, row) => sum + row.weight, 0) * 100 : null,
    top10HhiSharePct:
      effective?.topTenConcentrationShare != null
        ? effective.topTenConcentrationShare * 100
        : null,
    top1:
      top1 === null
        ? null
        : { name: top1.name, ticker: top1.ticker, weightPct: top1.weight * 100 },
    worst:
      worstRow === undefined
        ? null
        : { name: worstRow.name, heldBy: worstRow.holder_count },
    fundCount: funds.length,
    coveredPct: effective === null ? null : effective.matchedWeight * 100,
    benchmark,
    ratio: benchmark && core ? benchmark.effective / core : null,
    benchmarkMissing: model.benchmark === null,
  };
}

/** The chip row that controls the comparison, moved above the section as the plan asks. */
function BenchmarkChips() {
  const { benchmark, setBenchmark } = useBenchmarkPreference();
  return (
    <div className={styles.chips} role="group" aria-labelledby="proto-benchmark-label">
      <span className={styles.chipsLabel} id="proto-benchmark-label">
        Compare against
      </span>
      {BENCHMARK_CHOICES.map((ticker) => (
        <button
          key={ticker}
          type="button"
          className={styles.chip}
          aria-pressed={ticker === benchmark}
          onClick={() => setBenchmark(ticker)}
        >
          {ticker}
        </button>
      ))}
    </div>
  );
}

function Bars({ view }: { view: View }) {
  if (view.effective === null) return null;
  const rows: Array<{ key: string; label: string; value: number; tone: "you" | "neutral" }> = [
    { key: "you", label: "You", value: view.effective, tone: "you" },
  ];
  if (view.benchmark && !view.benchmarkMissing) {
    rows.push({
      key: "bench",
      label: view.benchmark.ticker,
      value: view.benchmark.effective,
      tone: "neutral",
    });
  }
  if (!view.singleFund && !view.noShared && view.noOverlap !== null) {
    rows.push({
      key: "nooverlap",
      label: "Your funds, if they didn't overlap",
      value: view.noOverlap,
      tone: "neutral",
    });
  }
  const max = Math.max(...rows.map((row) => row.value)) * 1.1;
  return (
    <ul className={styles.bars} aria-label="Effective number of companies, compared">
      {rows.map((row) => (
        <li key={row.key} className={styles.barRow} aria-label={`${row.label}: ${effectiveWords(row.value)} effective companies`}>
          <span className={styles.barLabel}>{row.label}</span>
          <span className={styles.track} aria-hidden="true">
            <span
              className={`${styles.fill} ${row.tone === "you" ? styles.you : styles.neutral}`}
              style={{ width: `${(row.value / max) * 100}%` }}
            />
          </span>
          <span className={`${styles.barValue} mono`}>{effectiveWords(row.value)}</span>
        </li>
      ))}
    </ul>
  );
}

function Bullets({ view }: { view: View }) {
  const top1 = view.top1;
  return (
    <ul className={styles.bullets}>
      {view.top10WeightPct !== null && top1 ? (
        <li>
          Your 10 largest companies are {formatPct1(view.top10WeightPct / 100)} of your
          money. {top1.name} alone is {formatPct1(top1.weightPct / 100)}.
        </li>
      ) : null}
      {view.singleFund ? null : view.noShared ? (
        <li>
          Your funds don&apos;t share any companies, so overlap isn&apos;t reducing your
          diversification.
        </li>
      ) : view.worst && view.noOverlap !== null && view.effective !== null ? (
        <li>
          Overlap is the biggest reason. Your {formatCount(view.fundCount)} funds share
          their largest names ({view.worst.name} is in {formatCount(view.worst.heldBy)} of{" "}
          {formatCount(view.fundCount)}). Without that overlap you&apos;d have the
          diversification of {effectiveWords(view.noOverlap)} companies instead of{" "}
          {effectiveWords(view.effective)}.{" "}
          <a href="/" title="Prototype: opens the Portfolio tab">
            See Overlap →
          </a>
        </li>
      ) : null}
    </ul>
  );
}

function Details({ view }: { view: View }) {
  if (view.effective === null || view.lenient === null) return null;
  return (
    <details className={styles.details}>
      <summary>How this is calculated</summary>
      <p>
        <strong>Effective number of companies ({effectiveWords(view.effective)})</strong>{" "}
        = 1 ÷ Σ(weight²), using each company&apos;s combined weight across all your funds.
        It&apos;s the number of equally weighted companies that would give the same
        concentration. Example: two stocks at 50/50 → 2.0. At 90/10 → 1.2.
      </p>
      <p>
        <strong>Lenient count ({effectiveWords(view.lenient)})</strong> = e^(entropy of
        your weights). It gives more credit to the long tail of small positions, so
        it&apos;s always between the effective number and the number of companies you own.
      </p>
      <p>
        <strong>Without overlap ({effectiveWords(view.noOverlap ?? 0)}; lenient{" "}
        {effectiveWords(view.noOverlapLenient ?? 0)})</strong>: the same calculations if
        every fund&apos;s positions were separate companies. The gap from{" "}
        {effectiveWords(view.effective)} is how much diversification overlap costs you (
        {view.overlapCostPct ?? 0}%).
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
        {view.coveredPct === null ? "covered" : formatShare(view.coveredPct / 100)} of your
        portfolio that filings can place. Holdings as of each fund&apos;s latest public
        filing.
      </p>
    </details>
  );
}

function Headline({ view }: { view: View }) {
  if (view.singleStock) {
    return <p className={styles.headline}>Your portfolio is one company.</p>;
  }
  if (view.effective === null) return null;
  return (
    <p className={styles.headline}>
      You own {formatCount(view.owned)} companies, but your portfolio behaves like{" "}
      {effectiveWords(view.effective)} equally weighted ones.
    </p>
  );
}

function Verdict({ view }: { view: View }) {
  const line = view.benchmark ? verdictLine(view.ratio, view.benchmark.ticker) : null;
  if (line === null) return null;
  return <p className={styles.verdict}>{line}</p>;
}

function Section({ view }: { view: View }) {
  if (view.empty) {
    return (
      <p className="small muted" role="status">
        Add a fund or stock to see effective holdings.
      </p>
    );
  }
  return (
    <>
      <Headline view={view} />
      <Verdict view={view} />
      {!view.singleStock ? <Bars view={view} /> : null}
      {!view.singleStock ? <Bullets view={view} /> : null}
      {!view.singleStock ? <Details view={view} /> : null}
    </>
  );
}

function VariantB({ view }: { view: View }) {
  if (view.empty || view.effective === null) return <Section view={view} />;
  return (
    <>
      {view.singleStock ? (
        <Headline view={view} />
      ) : (
        <div className={styles.heroRow}>
          <div>
            <p className={styles.bigNumber}>{effectiveWords(view.effective)}</p>
            <p className={styles.bigCaption}>equally weighted companies</p>
            <p className={styles.smallHeadline}>
              You own {formatCount(view.owned)} companies.
            </p>
          </div>
          <div className={styles.heroSide}>
            <Verdict view={view} />
            <Bars view={view} />
          </div>
        </div>
      )}
      {!view.singleStock ? <Bullets view={view} /> : null}
      {!view.singleStock ? <Details view={view} /> : null}
    </>
  );
}

function VariantC({ view }: { view: View }) {
  if (view.empty) return <Section view={view} />;
  if (view.singleStock) return <Section view={view} />;
  return (
    <>
      <Verdict view={view} />
      <Bars view={view} />
      <Headline view={view} />
      <Bullets view={view} />
      <Details view={view} />
    </>
  );
}

export default function PrototypePage() {
  const [params, setParams] = useState<{ variant: Variant; scenario: Scenario }>({
    variant: "a",
    scenario: "example",
  });
  const model = useWorkspace();
  const view = useMemo(() => buildView(model), [model]);

  useEffect(() => {
    setParams(readParams());
    const onPop = () => setParams(readParams());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!model.ready) return;
    const want = SCENARIOS[params.scenario];
    if (!sameEntries(model.portfolio.entries, want)) write({ mode: "bp", entries: want });
  }, [model.ready, model.portfolio.entries, params.scenario]);

  const active = VARIANTS.find((variant) => variant.id === params.variant) ?? {
    id: "a" as Variant,
    name: "A · the plan, literally",
    question: "Does the plan's own order read on its own?",
  };

  return (
    <main id="main" className="shell page workspace">
      <p className="eyebrow">Prototype · not a shipped page</p>
      <h1 className="title">Effective holdings, redesigned</h1>
      <p className="subtitle">
        One question: which layout turns &ldquo;you own {formatCount(view.owned)} companies
        but behave like {view.effective === null ? "—" : effectiveWords(view.effective)}
        &rdquo; into an answer a first-time reader can use, and makes the benchmark and the
        overlap the visible comparison rather than a footnote?
      </p>
      <p className="small muted">
        Real data from the live release. The scenario control seeds the portfolio, so the
        address bar changes with it; that is the only state the prototype writes.
      </p>

      <div className={styles.scenarios} role="group" aria-labelledby="proto-scenario-label">
        <span className={styles.chipsLabel} id="proto-scenario-label">
          Scenario
        </span>
        {(Object.keys(SCENARIOS) as Scenario[]).map((scenario) => (
          <a
            key={scenario}
            className={styles.chip}
            aria-current={scenario === params.scenario ? "true" : undefined}
            href={`/prototype/?variant=${params.variant}&scenario=${scenario}`}
          >
            {SCENARIO_LABEL[scenario]}
          </a>
        ))}
      </div>

      <BenchmarkChips />

      <section className="card stack stack--tight" aria-labelledby="proto-section-heading">
        <h2 id="proto-section-heading" className="subtitle">
          Effective holdings
        </h2>
        {params.variant === "a" ? <Section view={view} /> : null}
        {params.variant === "b" ? <VariantB view={view} /> : null}
        {params.variant === "c" ? <VariantC view={view} /> : null}
      </section>

      <p className="small muted">
        {model.pendingFunds.length > 0
          ? `Reading ${model.pendingFunds.length} filings…`
          : model.ledger === null
            ? "Waiting for the look-through…"
            : "All filings loaded."}
      </p>

      <div className={styles.bar} role="navigation" aria-label="Prototype variants">
        <span className={styles.barTitle}>Variant</span>
        {VARIANTS.map((variant) => (
          <a
            key={variant.id}
            className={styles.chip}
            aria-current={variant.id === params.variant ? "true" : undefined}
            href={`/prototype/?variant=${variant.id}&scenario=${params.scenario}`}
          >
            {variant.name}
          </a>
        ))}
        <span className={styles.barQuestion}>{active.question}</span>
      </div>
    </main>
  );
}
