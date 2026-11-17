/**
 * The five numbers the lens strip shows, and the sentence each one is read as.
 *
 * The strip replaces the "What you own" card, so every fact that card carried has to
 * survive here or at the top of the lens it belongs to. This module is where that
 * mapping lives: one metric per lens, each with a headline number, a one-line
 * sub-label, and the sentence a screen reader hears.
 *
 * **Nothing is computed here that the ledger did not already compute.** The market
 * split is `marketSplit` from `answer.ts` — the same call the answer sentence makes —
 * and the overlap is `highestOverlap`, the same one the sentence uses. The only
 * arithmetic in this file is the largest fund's share of the portfolio, which is a
 * division of two numbers the portfolio already holds.
 *
 * **A dot only where the site already judges.** The Companies tab carries the
 * single-company risk band (`DIVERSIFICATION_BANDS`, the same five bands the Effective
 * holdings block prints). The Data quality tab carries a dot only below the 70% band
 * boundary `coverageBand` already defines. Overlap carries none: the methodology page
 * defines what overlap *is* (`web/app/methodology/page.tsx`, the `#overlap` section) and
 * sets no threshold on it, and `OVERLAP_NOTABLE` in `answer.ts` is a "worth a sentence"
 * cut-off, not a judgement. Inventing one here would be a number the site cannot defend.
 */

import { bandFor } from "@/lib/effective-holdings-view";
import {
  coverageBand,
  formatCount,
  formatDateLong,
  formatEffective,
  formatPct1,
  formatPct1Of,
} from "@/lib/format";
import { effectiveFundCount } from "@/lib/portfolio-weights";
import type { Provider } from "@/lib/country-tier";
import type { WorkspaceModel } from "@/lib/use-workspace";
import type { Lens } from "@/lib/view-fragment";

import { highestOverlap, marketSplit } from "./answer";
import { LENS_TABS } from "./types";

/** `55.6%` → `56%`: the compact form, for a tab too narrow for a decimal. */
function wholePct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** The coverage band boundary the Data quality dot answers to. */
export const COVERAGE_DOT_BELOW = 70;

export interface LensMetric {
  id: Lens;
  label: string;
  /** The headline number, or `null` while it is not known yet. */
  value: string | null;
  /** The one line under the number, or `null`. */
  sub: string | null;
  /**
   * A shorter form of `sub` for a narrow tab, or `null` when the exact form always
   * fits. Markets uses it to drop the decimal rather than let an ellipsis hide a tier.
   */
  subCompact?: string | null;
  /**
   * A three-segment bar in place of the headline number. Markets only: one percentage
   * cannot say "55.6% US, 30.3% DM, 13.7% EM", and three numbers stacked would be a
   * paragraph in a tab.
   */
  bar?: { us: number; dm: number; em: number } | null;
  /** What the tab's tooltip says, when it has one. */
  tip?: string | null;
  /** The compact form the docked strip shows for the active tab. */
  dockValue?: string | null;
  /** What a screen reader hears: a sentence, not a pile of fragments. */
  sentence: string;
  /**
   * A status dot, only where the site already judges. `band` is the token key the
   * stylesheet colours from; `text` is the same judgement in words, and it is appended
   * to `sentence` so the dot is never the only carrier.
   */
  dot: { band: string; text: string } | null;
}

/**
 * `Companies, 766, behaves like 42, Yellow · Moderate` — the tab's accessible name.
 *
 * The dot's judgement is appended here rather than left to the dot, because a colour is
 * never the only carrier: a screen reader hears the band, and a reader who cannot
 * separate the hues reads it in the panel.
 */
function sentenceOf(
  label: string,
  value: string | null,
  sub: string | null,
  dot: { text: string } | null = null,
): string {
  return [label, value, sub, dot?.text ?? null]
    .filter((part): part is string => Boolean(part))
    .join(", ");
}

/**
 * The five metrics, in tab order.
 *
 * Three states, and each one is honest about what it does not know: no portfolio at all
 * (every number absent, the tabs disabled), a portfolio whose filings are still being
 * read (numbers absent, the tabs still clickable so the reader can look at a lens while
 * it fills), and a finished ledger.
 */
export function buildMetrics(model: WorkspaceModel, provider: Provider): LensMetric[] {
  const ledger = model.ledger;
  const empty = !model.hasEntries;
  const loading = !empty && ledger === null;

  const metrics = new Map<Lens, LensMetric>();

  for (const tab of LENS_TABS) {
    metrics.set(tab.id, {
      id: tab.id,
      label: tab.label,
      value: null,
      sub: null,
      sentence: empty
        ? `${tab.label}, no portfolio yet`
        : loading
          ? `${tab.label}, reading the filings`
          : tab.label,
      dot: null,
    });
  }

  if (empty || loading || ledger === null) {
    return LENS_TABS.map((tab) => metrics.get(tab.id) as LensMetric);
  }

  // 1. Companies — the count, and what it behaves like.
  const effective = ledger.effective;
  const companyCount = formatCount(ledger.rows.length);
  const core = effective.core;
  const companiesSub = core === null ? null : `behaves like ${formatEffective(core)}`;
  const band = core === null ? null : bandFor(core);
  const riskDot =
    band === null ? null : { band: band.key, text: `${band.colour} · ${band.label}` };
  metrics.set("companies", {
    id: "companies",
    label: "Companies",
    value: companyCount,
    sub: companiesSub,
    sentence: sentenceOf("Companies", companyCount, companiesSub, riskDot),
    dot: riskDot,
  });

  // 2. Markets — all three tiers, labelled, over a bar.
  //
  // The old sub-label said "1.5% dev · 0.2% EM" and left the US share to the headline,
  // so a reader had to know that the big number was the United States. Every tier is
  // now named, and "DM" matches "EM" — "dev" was the only abbreviation in the app that
  // did not.
  const split = marketSplit(ledger, model.contested ?? {}, provider);
  if (split.placed > 0) {
    const us = formatPct1(split.us);
    const dm = formatPct1(split.dm);
    const em = formatPct1(split.em);
    const unplaced = Math.max(0, 1 - split.placed);
    // A share under half a percent is noise in a one-line label; above it, the reader
    // is owed the fact that the three tiers do not add to 100%.
    const notPlaced = unplaced >= 0.005 ? ` · ${formatPct1(unplaced)} not placed` : "";
    // The compact form drops the decimal everywhere, including the share that could not
    // be placed: mixing "65%" and "10.2%" in one line reads as a typo.
    const notPlacedCompact =
      unplaced >= 0.005 ? ` · ${wholePct(unplaced)} not placed` : "";
    const sub = `US ${us} · DM ${dm} · EM ${em}${notPlaced}`;
    const subCompact = `US ${wholePct(split.us)} · DM ${wholePct(split.dm)} · EM ${wholePct(
      split.em,
    )}${notPlacedCompact}`;
    const sentence =
      `Markets: United States ${us}, developed markets ex-US ${dm}, ` +
      `emerging markets ${em}${unplaced >= 0.005 ? `, ${formatPct1(unplaced)} not placed` : ""}`;
    metrics.set("markets", {
      id: "markets",
      label: "Markets",
      value: null,
      sub,
      subCompact,
      bar: { us: split.us, dm: split.dm, em: split.em },
      tip: sentence,
      dockValue: subCompact,
      sentence,
      dot: null,
    });
  }

  // 3. Funds — how many, and what they behave like.
  //
  // The sub-label used to name the largest fund, which told a reader nothing they could
  // act on and read as a stray ticker. It now carries the effective number of funds —
  // the same "behaves like" the Companies tab uses, one level up — and names the
  // non-fund holdings that the fund count deliberately excludes.
  const fundCount = formatCount(ledger.funds.length);
  const effectiveFunds = effectiveFundCount(model.split.fundWeights);
  const stocks = model.split.direct.length;
  const cash = model.split.cash;
  const extras: string[] = [];
  if (stocks > 0)
    extras.push(`+${formatCount(stocks)} ${stocks === 1 ? "stock" : "stocks"}`);
  if (cash > 0) extras.push(`cash ${formatPct1(cash)}`);
  const behaves =
    effectiveFunds === null ? null : `behaves like ${formatEffective(effectiveFunds)}`;
  const fundsSub = [behaves, ...extras].filter(Boolean).join(" · ") || null;
  // One phrase for the non-fund holdings, so the sentence reads "plus 1 stock and 10.0%
  // cash" rather than "... stock, and 10.0% cash".
  const stockPhrase =
    stocks > 0 ? `${formatCount(stocks)} ${stocks === 1 ? "stock" : "stocks"}` : null;
  const cashPhrase = cash > 0 ? `${formatPct1(cash)} cash` : null;
  const holdingsPhrase =
    stockPhrase && cashPhrase
      ? `plus ${stockPhrase} and ${cashPhrase}`
      : stockPhrase
        ? `plus ${stockPhrase}`
        : cashPhrase
          ? `plus ${cashPhrase}`
          : null;
  const fundsSentence = [
    "Funds",
    fundCount,
    behaves === null ? null : `${behaves} effective funds`,
    holdingsPhrase,
  ]
    .filter((part): part is string => Boolean(part))
    .join(", ");
  metrics.set("funds", {
    id: "funds",
    label: "Funds",
    value: fundCount,
    sub: fundsSub,
    sentence: fundsSentence,
    dot: null,
  });

  // 4. Overlap — the highest pairwise share, and the pair it belongs to.
  const contributing = model.funds.filter((fund) =>
    ledger.funds.some((entry) => entry.ticker === fund.ticker),
  );
  const overlap = highestOverlap(contributing);
  if (overlap !== null) {
    const shared = formatPct1(overlap.shared);
    const sub = `${overlap.a} ↔ ${overlap.b}`;
    metrics.set("overlap", {
      id: "overlap",
      label: "Overlap",
      value: shared,
      sub,
      sentence: sentenceOf("Overlap", shared, sub),
      dot: null,
    });
  }

  // 5. Data quality — coverage, and the oldest period behind it.
  if (ledger.funds.length > 0) {
    const covered = Math.max(0, Math.min(100, ledger.metrics.covered_weight_pct));
    const value = formatPct1Of(covered);
    const sub =
      ledger.oldest_as_of === null
        ? null
        : `oldest ${formatDateLong(ledger.oldest_as_of)}`;
    const below = coverageBand(covered) !== "full";
    const coverageDot = below
      ? { band: "coverage", text: `coverage below ${COVERAGE_DOT_BELOW}%` }
      : null;
    metrics.set("quality", {
      id: "quality",
      label: "Data quality",
      value,
      sub,
      sentence: sentenceOf("Data quality", value, sub, coverageDot),
      dot: coverageDot,
    });
  }

  return LENS_TABS.map((tab) => metrics.get(tab.id) as LensMetric);
}
