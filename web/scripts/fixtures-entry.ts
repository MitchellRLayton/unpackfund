/**
 * The fixture report: what the current code answers for the five test portfolios.
 *
 * Bundled by `check-fixtures.mjs` and run in Node, so it uses the *same* modules
 * the browser does — `buildLedger`, `splitPortfolio`, `decodePortfolio`, the
 * release loader — rather than a second implementation written for the check.
 * That is the whole point: a report produced by different code proves nothing
 * about the code under test.
 *
 * The output is deliberately plain text with fixed field order and no locale
 * formatting, so two runs can be diffed byte for byte.
 */

import { buildLedger } from "../lib/aggregate";
import { BENCHMARK_TICKER, benchmarkFor, benchmarkFromRollup } from "../lib/benchmark";
import { tierOf } from "../lib/country-tier";
import {
  loadBenchmark,
  loadCompanyCountries,
  loadFund,
  loadRelease,
  loadSecurities,
} from "../lib/data";
import { FIXTURES } from "../lib/fixtures/portfolios";
import { decodePortfolio } from "../lib/fragment";
import { splitPortfolio } from "../lib/portfolio-weights";
import type { DirectHolding, FundDocument } from "../lib/types";

/** Six decimals: enough to see a real difference, short enough to read. */
function n(value: number | null | undefined): string {
  if (value === null || value === undefined) return "null";
  return value.toFixed(6);
}

export async function run(): Promise<string> {
  const release = await loadRelease();
  const lines: string[] = [];
  lines.push(`release ${release.as_of}`);
  lines.push(`generated ${release.generated_at}`);

  const countries = await loadCompanyCountries(release).catch(() => null);

  for (const fixture of FIXTURES) {
    const decoded = decodePortfolio(fixture.fragment);
    if (!decoded.ok) {
      lines.push(`## ${fixture.id} DECODE-FAILED ${decoded.reason}`);
      continue;
    }
    const portfolio = decoded.portfolio;
    let skip = false;
    const split = splitPortfolio(portfolio.mode, portfolio.entries);

    const tickers = portfolio.entries
      .filter((entry) => entry.kind === "fund")
      .map((entry) => entry.key);
    const symbols = portfolio.entries
      .filter((entry) => entry.kind === "security")
      .map((entry) => entry.key);

    const funds: FundDocument[] = [];
    for (const ticker of tickers) {
      try {
        funds.push(await loadFund(release, ticker));
      } catch (error) {
        lines.push(
          `## ${fixture.id} FAILED loading ${ticker}: ${(error as Error).message}`,
        );
        skip = true;
        break;
      }
    }
    if (skip) continue;

    const securities =
      symbols.length > 0 ? await loadSecurities(release, symbols) : new Map();
    const direct: DirectHolding[] = [];
    for (const entry of split.direct) {
      const row = securities.get(entry.key);
      if (!row || row[3] !== "ok") continue;
      direct.push({
        company_id: row[0],
        name: row[1],
        ticker: entry.key,
        weight: entry.weight,
      });
    }

    const holdsBenchmark = tickers.includes(BENCHMARK_TICKER);
    let benchmark = null;
    if (!holdsBenchmark && (tickers.length > 0 || symbols.length > 0)) {
      const compact = release.objects.benchmarks?.files?.[BENCHMARK_TICKER];
      const rollup = compact ? await loadBenchmark(release, BENCHMARK_TICKER) : null;
      if (rollup) {
        benchmark = benchmarkFromRollup(rollup);
      } else {
        benchmark = benchmarkFor(await loadFund(release, BENCHMARK_TICKER));
      }
    }

    const ledger = buildLedger({
      funds,
      weights: split.fundWeights,
      direct,
      cash: split.cash,
      benchmark,
      countries,
    });

    lines.push("");
    lines.push(`## ${fixture.id}  ${fixture.label}`);
    lines.push(`companies ${ledger.rows.length}`);
    lines.push(`coverage_pct ${n(ledger.metrics.covered_weight_pct)}`);
    lines.push(`resolved_weight ${n(ledger.metrics.resolved_weight)}`);
    lines.push(`invested_weight ${n(ledger.metrics.invested_weight)}`);
    lines.push(`cash_weight ${n(ledger.metrics.cash_weight)}`);
    lines.push(`unallocated_weight ${n(ledger.metrics.unallocated_weight)}`);
    lines.push(`suppressed_weight ${n(ledger.metrics.suppressed_weight)}`);
    lines.push(`hhi ${n(ledger.metrics.hhi)}`);
    lines.push(`effective_n ${n(ledger.metrics.effective_n)}`);
    lines.push(`top10 ${n(ledger.metrics.top10)}`);
    lines.push(`unmapped_positions ${ledger.unmapped.positions}`);
    lines.push(`unmapped_securities_weight ${n(ledger.unmapped.securities_weight)}`);
    lines.push(
      `unmapped_cash_derivatives_weight ${n(ledger.unmapped.cash_and_derivatives_weight)}`,
    );
    lines.push(`oldest_as_of ${ledger.oldest_as_of ?? "null"}`);
    lines.push(`max_lag_days ${ledger.max_lag_days ?? "null"}`);

    // The market split, computed the way the Markets lens must compute it: by
    // summing the ledger's own row weights through the tier lookup.
    const tiers: Record<string, number> = { US: 0, DM: 0, EM: 0, OTHER: 0 };
    for (const row of ledger.rows) {
      const tier = tierOf(row.country);
      tiers[tier] = (tiers[tier] ?? 0) + row.weight;
    }
    lines.push(
      `tiers US=${n(tiers.US)} DM=${n(tiers.DM)} EM=${n(tiers.EM)} OTHER=${n(tiers.OTHER)}`,
    );

    for (const row of ledger.rows.slice(0, 10)) {
      lines.push(
        `row ${row.company_id} ${row.ticker ?? "-"} ${row.country ?? "--"} ${n(
          row.weight,
        )} ${n(row.benchmark_weight)} ${row.holder_count} ${row.held_directly ? "direct" : "fund"}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
