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
import { entryLabel } from "@/lib/holdings";
import type { Provider } from "@/lib/country-tier";
import type { WorkspaceModel } from "@/lib/use-workspace";
import type { Lens } from "@/lib/view-fragment";

import { highestOverlap, marketSplit } from "./answer";
import { LENS_TABS } from "./types";

/** The coverage band boundary the Data quality dot answers to. */
export const COVERAGE_DOT_BELOW = 70;

export interface LensMetric {
  id: Lens;
  label: string;
  /** The headline number, or `null` while it is not known yet. */
  value: string | null;
  /** The one line under the number, or `null`. */
  sub: string | null;
  /** What a screen reader hears: a sentence, not a pile of fragments. */
  sentence: string;
  /**
   * A status dot, only where the site already judges. `band` is the token key the
   * stylesheet colours from; `text` is the same judgement in words, and it is appended
   * to `sentence` so the dot is never the only carrier.
   */
  dot: { band: string; text: string } | null;
}

/** The fund with the largest share of the portfolio, by the amounts already entered. */
function largestFund(model: WorkspaceModel): { label: string; share: number } | null {
  const { entries, total } = model.portfolio;
  if (total <= 0) return null;
  let best: { label: string; amount: number } | null = null;
  for (const entry of entries) {
    if (entry.kind !== "fund") continue;
    if (best === null || entry.amount > best.amount) {
      best = { label: entryLabel(entry.kind, entry.key), amount: entry.amount };
    }
  }
  return best === null ? null : { label: best.label, share: best.amount / total };
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

  // 2. Markets — the US share, and the two tiers under it.
  const split = marketSplit(ledger, model.contested ?? {}, provider);
  if (split.placed > 0) {
    const us = formatPct1(split.us);
    const sub = `${formatPct1(split.dm)} dev · ${formatPct1(split.em)} EM`;
    metrics.set("markets", {
      id: "markets",
      label: "Markets",
      value: us,
      sub,
      sentence: sentenceOf("Markets", `${us} US`, sub),
      dot: null,
    });
  }

  // 3. Funds — how many, and which one is the largest.
  const fundCount = formatCount(ledger.funds.length);
  const largest = largestFund(model);
  const fundsSub = largest === null ? null : largest.label;
  metrics.set("funds", {
    id: "funds",
    label: "Funds",
    value: fundCount,
    sub: fundsSub,
    sentence: sentenceOf("Funds", fundCount, fundsSub),
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
