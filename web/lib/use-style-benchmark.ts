/**
 * The style benchmark, loaded and computed for the workspace model.
 *
 * This is the seam the plan's §9 asks for: the lens stays a pure reader, and everything
 * that needs the network or the release happens here, once, next to the ledger.
 *
 * Order matters and is the gate's own order (§6):
 *
 * 1. **Gate first, from documents already in memory.** Deciding whether the feature
 *    exists costs nothing; only a portfolio that passes makes the app fetch benchmarks.
 *    A failing gate therefore downloads no member fund at all.
 * 2. **Then the members.** One fetch per member ETF of the classes the gate selected —
 *    `VBR · IJS · IWN` for a small-value book, already cached by `useFunds` if the reader
 *    holds them.
 * 3. **Then the blend and the distance.** `style_weight(company) = Σ alloc × bench`, and
 *    active share against the ledger's own company weights, which is why this hook takes
 *    the ledger rather than re-deriving the portfolio.
 *
 * The POC computes the composite in the browser rather than reading a per-class artifact
 * from R2 (§7): publishing 17 new objects would be a release change, and this build may
 * not touch production data. The arithmetic is the same and `compositeFromDocuments` is
 * written so a future loader can feed it a published artifact instead.
 */

import { useMemo } from "react";

import { tierOf } from "@/lib/country-tier";
import type { Ledger, LedgerRow, ReleaseDescriptor } from "@/lib/types";
import type { FundDocument } from "@/lib/types";
import { useFunds } from "@/lib/use-release";

import {
  activeShare,
  blendWeights,
  compositeFromDocuments,
  resolveStyleBenchmark,
  type ClassBenchmark,
  type GateResult,
  type RegionMix,
} from "./style-benchmark";
import { STYLE_CLASS_BY_ID, type StyleClass } from "./style-registry";

/** Basis points in 100%. */
const FULL_BP = 10_000;

export interface StyleBenchmarkState {
  gate: Extract<GateResult, { eligible: true }>;
  /** Company id → weight in the blended style benchmark. */
  weights: Record<string, number>;
  /** `½ Σ |yours − benchmark|`; 0 when the reader holds the benchmark itself. */
  activeShare: number;
  /** The classes used, with the members that actually contributed. */
  classes: { styleClass: StyleClass; composite: ClassBenchmark }[];
  /** The newest filing date across the members used. */
  asOf: string | null;
  /** The caption's middle clause: "US Small Cap Value (index blend: VBR · IJS · IWN, as of …)". */
  caption: string;
  /** True when the reader's book and the benchmark agree — print words, not zeros. */
  holdsBenchmark: boolean;
  /** Members the registry names but the release could not supply (shown in the tooltip). */
  dropped: { ticker: string; why: "missing" | "stale" }[];
}

export interface StyleBenchmarkResult {
  /** `null` while the gate has not run, or when this build has the feature switched off. */
  state: StyleBenchmarkState | null;
  /** The gate's verdict as it stands, including the reason when it failed. */
  gate: GateResult | null;
  /** Tickers still arriving, so the POC can say what it is waiting for. */
  pending: string[];
}

/** The POC's switch: nothing renders unless the build asks for it. */
export function styleBenchmarkEnabled(): boolean {
  return process.env.NEXT_PUBLIC_STYLE_BENCH === "1";
}

/**
 * A fund's look-through by region, from the release's company→country map.
 *
 * `tierOf` is the same classifier the Markets bar uses, so a fund cannot be "US" here and
 * "International Developed" three tabs away. Weight the release could not place — cash, a
 * derivative, a company with no country — counts as unplaced, never as US.
 */
export function regionMixOf(
  fund: FundDocument,
  countries: Record<string, string> | null,
): RegionMix {
  const mix: RegionMix = { us: 0, dm: 0, em: 0, unplaced: 0 };
  for (const holding of fund.holdings) {
    const weight = holding.weight_bp / FULL_BP;
    if (weight === 0) continue;
    const country = holding.company_id ? (countries?.[holding.company_id] ?? null) : null;
    const tier = tierOf(country);
    if (tier === "US") mix.us += weight;
    else if (tier === "DM") mix.dm += weight;
    else if (tier === "EM") mix.em += weight;
    else mix.unplaced += weight;
  }
  return mix;
}

/** A fund's weight in each company, as a fraction of its own NAV. */
function companyWeightsOf(fund: FundDocument): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const holding of fund.holdings) {
    if (!holding.company_id || holding.weight_bp === 0) continue;
    weights[holding.company_id] =
      (weights[holding.company_id] ?? 0) + holding.weight_bp / FULL_BP;
  }
  return weights;
}

/** The portfolio's own company weights, from the ledger the table is already showing. */
export function portfolioCompanyWeights(rows: LedgerRow[]): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const row of rows) weights[row.company_id] = row.weight;
  return weights;
}

export function useStyleBenchmark(
  release: ReleaseDescriptor | null,
  funds: FundDocument[],
  fundWeights: { ticker: string; weight: number }[],
  ledger: Ledger | null,
  countries: Record<string, string> | null,
): StyleBenchmarkResult {
  const enabled = styleBenchmarkEnabled();

  // Step 1: the gate, on documents that are already in memory.
  const gate = useMemo<GateResult | null>(() => {
    if (!enabled || !ledger || fundWeights.length === 0) return null;
    const byTicker = new Map(funds.map((fund) => [fund.ticker.toUpperCase(), fund]));
    return resolveStyleBenchmark(fundWeights, {
      regionMix: (ticker) => {
        const fund = byTicker.get(ticker);
        // No document yet is "not known", not a failure: the gate re-runs when it lands.
        return fund ? regionMixOf(fund, countries) : null;
      },
    });
  }, [enabled, ledger, fundWeights, funds, countries]);

  // Step 2: the members of every class the gate selected, and only those.
  const memberTickers = useMemo(() => {
    if (!gate?.eligible) return [];
    const wanted = new Set<string>();
    for (const entry of gate.classes) {
      for (const member of STYLE_CLASS_BY_ID.get(entry.classId)?.members ?? []) {
        wanted.add(member);
      }
    }
    return [...wanted].sort();
  }, [gate]);

  const members = useFunds(release, memberTickers);

  // Step 3: build, blend, and measure the distance.
  const state = useMemo<StyleBenchmarkState | null>(() => {
    if (!gate?.eligible || !ledger) return null;

    const composites = new Map<string, ClassBenchmark>();
    const classes: StyleBenchmarkState["classes"] = [];
    const dropped: StyleBenchmarkState["dropped"] = [];
    for (const entry of gate.classes) {
      const styleClass = STYLE_CLASS_BY_ID.get(entry.classId);
      if (!styleClass) continue;
      const documents = members.funds.filter((fund) =>
        styleClass.members.includes(fund.ticker.toUpperCase()),
      );
      // Wait for every member the release can give us before computing: an average over
      // two of three members is a different benchmark, and a half-built one would flash.
      if (documents.length === 0 && members.pending.length > 0) return null;
      const composite = compositeFromDocuments(entry.classId, documents);
      if (Object.keys(composite.weights).length === 0) continue;
      composites.set(entry.classId, composite);
      classes.push({ styleClass, composite });
      dropped.push(...composite.dropped);
    }
    if (classes.length === 0) return null;

    const weights = blendWeights(gate.classes, composites);
    const distance = activeShare(portfolioCompanyWeights(ledger.rows), weights);
    const asOf =
      classes
        .map((entry) => entry.composite.asOf)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null;

    return {
      gate,
      weights,
      activeShare: distance,
      classes,
      asOf,
      caption: captionFor(gate, classes),
      // 0.5% is the POC's tolerance for "the same book": the two vectors come from the
      // same filings, so an exact match reads 0 and a rounded one is still the same fund.
      holdsBenchmark: distance < 0.005,
      dropped,
    };
  }, [gate, ledger, members.funds, members.pending.length]);

  return { state, gate, pending: members.pending };
}

/**
 * The caption's middle clause, exactly as §1 specifies it.
 *
 * One class: `US Small Cap Value (index blend: VBR · IJS · IWN, as of 2026-09-30)`.
 * Several: `Style blend: 60% US Small Cap Value · 40% Intl Small Cap Value`.
 */
export function captionFor(
  gate: Extract<GateResult, { eligible: true }>,
  classes: { styleClass: StyleClass; composite: ClassBenchmark }[],
): string {
  const kindWord = (styleClass: StyleClass): string =>
    styleClass.kind === "index_blend"
      ? "index blend"
      : styleClass.kind === "peer_composite"
        ? "peer composite"
        : "single ETF";

  if (classes.length === 1) {
    const [only] = classes;
    if (!only) return "";
    const memberList = only.composite.members.map((member) => member.ticker).join(" · ");
    return `${only.styleClass.display} (${kindWord(only.styleClass)}: ${memberList}, as of ${only.composite.asOf ?? "unknown"})`;
  }

  return `Style blend: ${classes
    .map(({ styleClass }) => {
      const alloc =
        gate.classes.find((entry) => entry.classId === styleClass.id)?.alloc ?? 0;
      return `${Math.round(alloc * 100)}% ${styleClass.display}`;
    })
    .join(" · ")}`;
}
