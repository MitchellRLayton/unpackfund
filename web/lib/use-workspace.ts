"use client";

/**
 * One model for the whole workspace, so every surface reads the same numbers.
 *
 * The redesign merges the builder and the ledger into one screen, which means the
 * holdings pane, the answer strip and five lenses all need the same portfolio, the
 * same fund documents, the same benchmark and the same ledger. Composing that in
 * each component would let two of them disagree — the failure mode the old split
 * between `/` and `/x` already produced once.
 *
 * The composition itself is the ledger's, unchanged: `splitPortfolio` turns entries
 * into fund weights, direct holdings and cash; `useFunds` and `useSecurities` load
 * only what the portfolio names; `useLedger` runs the aggregation in the worker.
 * Nothing here computes a number — it only decides what is loaded and what is
 * exposed.
 */

import { useCallback, useMemo } from "react";

import { benchmarkFor, benchmarkFromRollup } from "./benchmark";
import { useBenchmarkPreference } from "./benchmark-preference";
import { getSnapshot, writeCompany, writeLens } from "./fragment-store";
import { splitPortfolio } from "./portfolio-weights";
import { useLedger } from "./use-ledger";
import { usePortfolio, type PortfolioState } from "./use-portfolio";
import {
  useBenchmark,
  useCountries,
  useFunds,
  useRelease,
  type LoadState,
} from "./use-release";
import { useSecurities, type SecuritiesState } from "./use-securities";
import { useStyleBenchmark, type StyleBenchmarkResult } from "./use-style-benchmark";
import type {
  BenchmarkComparison,
  DirectHolding,
  FundDocument,
  Ledger,
  ReleaseDescriptor,
} from "./types";
import type { Lens } from "./view-fragment";

export interface WorkspaceModel {
  /** `false` until the fragment has been read on the client. */
  ready: boolean;
  /** A decode problem with the link, in words, or `null`. */
  problem: string | null;
  release: LoadState<ReleaseDescriptor>;
  releaseAsOf: string | null;
  portfolio: PortfolioState;
  split: ReturnType<typeof splitPortfolio>;
  funds: FundDocument[];
  /** Tickers still arriving, so a loading state can name them. */
  pendingFunds: string[];
  fundsError: { message: string; detail: string } | null;
  securities: SecuritiesState;
  countries: Record<string, string> | null;
  benchmark: BenchmarkComparison | null;
  /**
   * The style benchmark for this portfolio, when the POC's flag is on and the gate passes
   * (`equity-style-benchmark-plan.md` §6). `state` is `null` both when the feature is off
   * and when the portfolio is not one style family — `gate` says which, and the lens reads
   * only `state`, so a failed gate renders nothing rather than a reason.
   */
  style: StyleBenchmarkResult;
  ledger: Ledger | null;
  ledgerError: string | null;
  ledgerMode: "worker" | "main-thread";
  durationMs: number | null;
  /** True when the portfolio names at least one fund or stock. */
  hasHoldings: boolean;
  /** Any entry at all, cash included. A cash-only mix is a portfolio with nothing to
   * look through, which is a different sentence from "no portfolio yet". */
  hasEntries: boolean;
  /** True when the entries account for the whole portfolio. */
  complete: boolean;
  lens: Lens;
  setLens: (lens: Lens) => void;
  companyId: string | null;
  openCompany: (companyId: string | null) => void;
  /** The fund documents by ticker, for a lens that needs a fund's own facts. */
  fundByTicker: Map<string, FundDocument>;
  /** A company's country code, or `null` when the release does not answer. */
  countryOf: (companyId: string) => string | null;
  /**
   * The release's *second* answer for a company the vote could not decide: the country
   * holding the largest share of the money in it. Only the Markets bar reads it — the
   * company tag keeps `countryOf`, which is still "we decline to place it".
   */
  contested: Record<string, string>;
}

/** One shared empty map: a fresh `{}` per render would re-run every memo that reads it. */
const EMPTY_CONTESTED: Record<string, string> = {};

export function useWorkspace(): WorkspaceModel {
  // Which fund the comparison columns are against. A display preference in the query
  // string, so it is read before anything loads: the benchmark fetch and the ledger
  // recompute follow the choice. Default VT keeps a plain URL benchmark-free.
  const { benchmark: benchmarkTicker } = useBenchmarkPreference();
  const portfolio = usePortfolio();
  const release = useRelease();
  const releaseData = release.status === "ready" ? release.data : null;

  const tickers = useMemo(
    () =>
      portfolio.entries
        .filter((entry) => entry.kind === "fund")
        .map((entry) => entry.key),
    [portfolio.entries],
  );
  const symbols = useMemo(
    () =>
      portfolio.entries
        .filter((entry) => entry.kind === "security")
        .map((entry) => entry.key),
    [portfolio.entries],
  );

  const { funds, pending, error: fundsError } = useFunds(releaseData, tickers);
  const securities = useSecurities(releaseData, symbols);

  const split = useMemo(
    () => splitPortfolio(portfolio.mode, portfolio.entries),
    [portfolio.mode, portfolio.entries],
  );

  const direct = useMemo<DirectHolding[]>(() => {
    const holdings: DirectHolding[] = [];
    for (const entry of split.direct) {
      const row = securities.rows.get(entry.key);
      if (!row || row[3] !== "ok") continue;
      holdings.push({
        company_id: row[0],
        name: row[1],
        ticker: entry.key,
        weight: entry.weight,
      });
    }
    return holdings;
  }, [split.direct, securities.rows]);

  // The benchmark is read from the fund document in memory, the compact rollup, or
  // the full document — the same three-way fallback the ledger has always used, so
  // the comparison column cannot tell which one answered. Only VT has a compact
  // rollup in the release; the other four choices take the fund-document path.
  const holdsBenchmark = portfolio.entries.some(
    (entry) => entry.kind === "fund" && entry.key === benchmarkTicker,
  );
  const hasHoldings = tickers.length > 0 || symbols.length > 0;
  const hasEntries = portfolio.entries.length > 0;
  const wantsBenchmark = !holdsBenchmark && hasHoldings;
  const compactEntry = releaseData?.objects.benchmarks?.files?.[benchmarkTicker];
  const wantsCompact = wantsBenchmark && compactEntry !== undefined;
  const wantsFundDocument = wantsBenchmark && compactEntry === undefined;
  const compactLoad = useBenchmark(releaseData, wantsCompact ? benchmarkTicker : null);
  const benchmarkLoad = useFunds(releaseData, wantsFundDocument ? [benchmarkTicker] : []);
  const benchmark = useMemo(() => {
    const inMemory = funds.find((fund) => fund.ticker === benchmarkTicker);
    if (inMemory) return benchmarkFor(inMemory);
    if (compactLoad.data) return benchmarkFromRollup(compactLoad.data);
    const document = benchmarkLoad.funds[0];
    return document ? benchmarkFor(document) : null;
  }, [funds, benchmarkTicker, compactLoad.data, benchmarkLoad.funds]);

  const countriesLoad = useCountries(releaseData);
  const {
    ledger,
    error: ledgerError,
    mode: ledgerMode,
    durationMs,
  } = useLedger(
    funds,
    split.fundWeights,
    direct,
    split.cash,
    benchmark,
    countriesLoad.data?.companies ?? null,
  );

  const style = useStyleBenchmark(
    releaseData,
    funds,
    useMemo(
      () =>
        Object.entries(split.fundWeights).map(([ticker, weight]) => ({ ticker, weight })),
      [split.fundWeights],
    ),
    ledger,
    countriesLoad.data?.companies ?? null,
  );

  const fundByTicker = useMemo(() => {
    const map = new Map<string, FundDocument>();
    for (const fund of funds) map.set(fund.ticker, fund);
    return map;
  }, [funds]);

  const countryOf = useCallback(
    (companyId: string) => countriesLoad.data?.companies[companyId] ?? null,
    [countriesLoad.data],
  );

  const setLens = useCallback((lens: Lens) => {
    writeLens(lens);
  }, []);

  const openCompany = useCallback((companyId: string | null) => {
    writeCompany(companyId);
  }, []);

  // The view state is read from the store rather than held in React, so the address
  // bar, the back button and the tabs cannot disagree.
  const snapshot = getSnapshot();

  return {
    ready: portfolio.ready,
    problem: portfolio.problem,
    release,
    releaseAsOf: releaseData?.as_of ?? null,
    portfolio,
    split,
    funds,
    style,
    pendingFunds: pending,
    fundsError,
    securities,
    countries: countriesLoad.data?.companies ?? null,
    benchmark,
    ledger,
    ledgerError,
    ledgerMode,
    durationMs,
    hasHoldings,
    hasEntries,
    complete: portfolio.complete,
    lens: snapshot.lens,
    setLens,
    companyId: snapshot.companyId,
    openCompany,
    fundByTicker,
    countryOf,
    contested: countriesLoad.data?.contested ?? EMPTY_CONTESTED,
  };
}
