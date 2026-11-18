"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { formatCount, formatDateLong, formatShare } from "@/lib/format";
import { encodeComparison } from "@/lib/fragment";
import { writeComparison } from "@/lib/fragment-store";
import { tallyOf } from "@/lib/holdings";
import { buildOverlap } from "@/lib/overlap";
import type { FundWeight } from "@/lib/types";
import {
  useCatalogue,
  useCountries,
  useFunds,
  useRelease,
  useTickers,
} from "@/lib/use-release";
import { useComparison, type Side } from "@/lib/use-comparison";

import { InfoTip } from "@/components/feedback/InfoTip";
import { useProvider } from "@/components/lenses/provider-preference";
import { Term } from "@/components/prose/Term";

import styles from "./compare.module.css";
import { MarketSplitChart } from "./MarketSplitChart";
import { MixColumn } from "./MixColumn";
import { OverlapTabs } from "./OverlapTabs";
import {
  coverageGap,
  describePartial,
  joinWithAnd,
  marketSplit,
  mixTotals,
  sourceTickers,
} from "./result";
import { scaleToWhole, splitEvenly } from "./sides";

/**
 * `/compare`: two mixes on one page, the companies they share, and the markets
 * they each sit in.
 *
 * The page is a function of the URL fragment and the published release, nothing
 * else — no storage, no request of its own beyond the data every page loads. Both
 * sides are the same `MixColumn`, and the answer is `buildOverlap`'s number printed
 * as it comes back, because a comparison whose headline disagreed with its own table
 * by a basis point would be worse than no comparison.
 *
 * The one structural rule: the answer is withheld rather than normalised. A side
 * that does not total 100%, and a fund whose coverage withholds its weights, both
 * stop the number — and the page says which side, or which fund, in words.
 */
export function CompareSurface() {
  const comparison = useComparison();
  const release = useRelease();
  const descriptor = release.status === "ready" ? release.data : null;
  const tickers = useTickers(descriptor);
  const catalog = tickers.status === "ready" ? tickers.data : [];

  // The catalogue is 180 KB of names; it is fetched the first time someone types in
  // an add field, not on load. Suggestions are a convenience — a typed ticker still
  // resolves without it.
  const [namesWanted, setNamesWanted] = useState(false);
  const catalogueState = useCatalogue(namesWanted ? descriptor : null);
  const countries = useCountries(descriptor);
  // The same convention the Markets lens shows: one choice, read from the URL.
  const { provider } = useProvider();

  const allTickers = useMemo(() => {
    const seen = new Set<string>();
    for (const entry of [...comparison.a, ...comparison.b]) seen.add(entry.ticker);
    return [...seen].sort();
  }, [comparison.a, comparison.b]);

  const { funds, pending, error } = useFunds(descriptor, allTickers);

  const names = useMemo(
    () => new Map(funds.map((fund) => [fund.ticker, fund.name] as const)),
    [funds],
  );
  const coverage = useMemo(
    () => new Map(funds.map((fund) => [fund.ticker, fund.coverage_pct] as const)),
    [funds],
  );
  const byTicker = useMemo(
    () => new Map(funds.map((fund) => [fund.ticker, fund] as const)),
    [funds],
  );

  const tallyA = useMemo(
    () =>
      tallyOf(
        "bp",
        comparison.a.map((entry) => entry.weight_bp),
      ),
    [comparison.a],
  );
  const tallyB = useMemo(
    () =>
      tallyOf(
        "bp",
        comparison.b.map((entry) => entry.weight_bp),
      ),
    [comparison.b],
  );

  const fundsA = useMemo(
    () => comparison.a.flatMap((entry) => byTicker.get(entry.ticker) ?? []),
    [comparison.a, byTicker],
  );
  const fundsB = useMemo(
    () => comparison.b.flatMap((entry) => byTicker.get(entry.ticker) ?? []),
    [comparison.b, byTicker],
  );

  const bothSides = comparison.a.length > 0 && comparison.b.length > 0;
  const loaded =
    descriptor !== null &&
    pending.length === 0 &&
    error === null &&
    fundsA.length === comparison.a.length &&
    fundsB.length === comparison.b.length;
  const canCompare = loaded && bothSides && tallyA.complete && tallyB.complete;

  const overlap = useMemo(() => {
    if (!canCompare) return null;
    // `buildOverlap` takes basis points keyed by ticker, which is the shape the
    // ledger's own portfolio uses; the number it returns is printed unchanged.
    const weights = (entries: FundWeight[]) =>
      Object.fromEntries(entries.map((entry) => [entry.ticker, entry.weight_bp]));
    return buildOverlap({
      a: { funds: fundsA, weightsBp: weights(comparison.a) },
      b: { funds: fundsB, weightsBp: weights(comparison.b) },
    });
  }, [canCompare, fundsA, fundsB, comparison.a, comparison.b]);

  const gap = useMemo(
    () => (canCompare ? coverageGap(fundsA, fundsB) : { suppressed: [], partial: [] }),
    [canCompare, fundsA, fundsB],
  );

  const sources = useMemo(
    () =>
      overlap
        ? {
            a: sourceTickers(overlap.ledgerA.rows),
            b: sourceTickers(overlap.ledgerB.rows),
          }
        : { a: new Map<string, string[]>(), b: new Map<string, string[]>() },
    [overlap],
  );

  const splits = useMemo(() => {
    if (!overlap || countries.status !== "ready") return null;
    return {
      a: marketSplit(overlap.ledgerA.rows, countries.data?.companies ?? null, provider),
      b: marketSplit(overlap.ledgerB.rows, countries.data?.companies ?? null, provider),
    };
  }, [overlap, countries, provider]);

  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }, []);

  /**
   * Rewrite one side wholesale, for the two buttons that do (`scaleToWhole` and
   * the store's own `equalise`). `useComparison` has no replace mutator, and a
   * sequence of `setWeightBp` calls would each build its next list from the same
   * snapshot and undo the one before, so the write goes through the store's single
   * writer with both sides in hand. Nothing else on the page writes directly.
   */
  const replaceSide = useCallback(
    (side: Side, next: FundWeight[]) => {
      writeComparison(
        side === "a" ? next : comparison.a,
        side === "b" ? next : comparison.b,
      );
    },
    [comparison.a, comparison.b],
  );

  const bothEmpty = comparison.a.length === 0 && comparison.b.length === 0;
  const oldest = oldestFiling([...fundsA, ...fundsB]);
  const shortSides = [
    { label: "Mix A", tally: tallyA },
    { label: "Mix B", tally: tallyB },
  ].filter((side) => !side.tally.complete);
  const shortHeadline =
    shortSides.length === 2
      ? "Not yet: both mixes have to total 100%."
      : `Not yet: ${shortSides[0]?.label ?? "each mix"} has to total 100%.`;

  let result: ReactNode;
  if (!comparison.ready) {
    result = <p className="small muted">Reading the link…</p>;
  } else if (comparison.problem) {
    result = notice(
      "This link could not be read.",
      `${comparison.problem} Start a comparison below, or clear the address bar and load the page again.`,
    );
  } else if (release.status === "error") {
    result = notice(
      "The fund data could not be loaded.",
      `${release.error.message} Reload the page to try again.`,
    );
  } else if (release.status === "loading") {
    result = <p className="small muted">Loading the fund data…</p>;
  } else if (error) {
    result = notice(
      "A fund could not be read.",
      `${error.message} The comparison is withheld while a fund it names is missing.`,
    );
  } else if (pending.length > 0) {
    result = (
      <p className="small muted">
        {pending.length > 4
          ? `Loading ${formatCount(pending.length)} funds…`
          : `Loading ${joinWithAnd(pending)}…`}
      </p>
    );
  } else if (!bothSides) {
    const filled = comparison.a.length > 0 ? "a" : "b";
    const filledLabel = filled === "a" ? "Mix A" : "Mix B";
    const emptyLabel = filled === "a" ? "Mix B" : "Mix A";
    const portfolio = filled === "a" ? comparison.a : comparison.b;
    result = (
      <div className="stack stack--tight">
        <div className="answer">
          <p className="answer__sentence">This is a portfolio, not a comparison.</p>
          <p className="answer__note">
            Only {filledLabel} has funds. A comparison needs both sides: add funds to{" "}
            {emptyLabel}, and the companies the two mixes hold in common appear here, with
            the share of each mix they account for.
          </p>
        </div>
        <p className="small">
          <Link href={`/x/#${encodeComparison(portfolio, [])}`}>
            Open {filledLabel} in the X-Ray
          </Link>
        </p>
      </div>
    );
  } else if (shortSides.length > 0) {
    result = (
      <div className="stack stack--tight">
        <div className="answer">
          <p className="answer__sentence">{shortHeadline}</p>
          {/* CN_COMPARE_NOT_100. The refusal's reasoning is methodology#overlap (MA-11). */}
          <p className="answer__note">
            {mixTotals(shortSides)} Scale to 100% to compare.
          </p>
        </div>
      </div>
    );
  } else if (gap.suppressed.length > 0) {
    result = (
      <div className="answer">
        {/* CN_COMPARE_WITHHELD. Why a floor withholds the figure lives at
            methodology#overlap (MA-12), not on every withheld page. */}
        <p className="answer__sentence">
          Overlap withheld: {joinWithAnd(gap.suppressed.map((fund) => fund.ticker))}{" "}
          {gap.suppressed.length === 1 ? "is" : "are"} under 60% traced.
        </p>
      </div>
    );
  } else if (overlap) {
    result = (
      <div className="stack stack--tight">
        <div className="answer">
          <p className="answer__sentence">
            These mixes <Term name="overlap">overlap</Term> by{" "}
            <strong>{formatShare(overlap.overlap)}</strong>.
          </p>
          <p className="answer__note">
            {formatCount(overlap.sharedCount)} shared of {formatCount(overlap.unionCount)}{" "}
            companies · <Term name="coverage">Covered</Term>: A{" "}
            {formatShare(overlap.ledgerA.metrics.resolved_weight)}, B{" "}
            {formatShare(overlap.ledgerB.metrics.resolved_weight)}
            {oldest ? ` · Oldest holdings ${formatDateLong(oldest)}` : ""}
          </p>
          {gap.partial.length > 0 ? (
            <p className="answer__note">{describePartial(gap.partial)}</p>
          ) : null}
        </div>
        <OverlapTabs overlap={overlap} sources={sources} />
      </div>
    );
  } else {
    result = <p className="small muted">The overlap is not available.</p>;
  }

  return (
    <div className="stack stack--loose">
      <header className="stack stack--tight">
        <div className={styles.head}>
          <h1 className="title">Compare two mixes</h1>
          <div className={styles.headActions}>
            <button type="button" className="btn btn--primary" onClick={copyLink}>
              Share
            </button>
            <InfoTip label="Share">
              Your comparison lives only in this link. Nothing is saved.
            </InfoTip>
            <span className={styles.copyStatus} role="status">
              {copyState === "copied"
                ? "Link copied. Your comparison lives only in this link."
                : copyState === "failed"
                  ? "Copy failed — the address bar holds the same link."
                  : ""}
            </span>
          </div>
        </div>
        <p className="lede">See which companies two mixes of funds share.</p>
      </header>

      <div className={styles.columns}>
        <MixColumn
          headingId="mix-a-heading"
          label="Mix A"
          entries={comparison.a}
          tally={tallyA}
          names={names}
          coverage={coverage}
          present={comparison.a.map((entry) => entry.ticker)}
          catalog={catalog}
          release={release}
          catalogue={catalogueState.status === "ready" ? catalogueState.data : null}
          catalogueState={catalogueState}
          onNeedNames={() => setNamesWanted(true)}
          onAdd={(ticker) => comparison.add("a", ticker)}
          onRemove={(ticker) => comparison.remove("a", ticker)}
          onWeight={(ticker, weightBp) => comparison.setWeightBp("a", ticker, weightBp)}
          onScale={() => replaceSide("a", scaleToWhole(comparison.a))}
          onSplit={() => replaceSide("a", splitEvenly(comparison.a))}
          onClear={() => comparison.clear("a")}
        />
        <MixColumn
          headingId="mix-b-heading"
          label="Mix B"
          entries={comparison.b}
          tally={tallyB}
          names={names}
          coverage={coverage}
          present={comparison.b.map((entry) => entry.ticker)}
          catalog={catalog}
          release={release}
          catalogue={catalogueState.status === "ready" ? catalogueState.data : null}
          catalogueState={catalogueState}
          onNeedNames={() => setNamesWanted(true)}
          onAdd={(ticker) => comparison.add("b", ticker)}
          onRemove={(ticker) => comparison.remove("b", ticker)}
          onWeight={(ticker, weightBp) => comparison.setWeightBp("b", ticker, weightBp)}
          onScale={() => replaceSide("b", scaleToWhole(comparison.b))}
          onSplit={() => replaceSide("b", splitEvenly(comparison.b))}
          onClear={() => comparison.clear("b")}
        />
      </div>

      {bothSides ? (
        <div className={styles.swap}>
          <button
            type="button"
            className="btn btn--sm btn--quiet"
            onClick={comparison.swap}
          >
            Swap A and B
          </button>
        </div>
      ) : null}

      <section className="stack stack--tight" aria-labelledby="overlap-heading">
        <h2 id="overlap-heading" className="eyebrow">
          The overlap
        </h2>
        {bothEmpty && comparison.ready ? (
          <div className="empty">
            <h2 className="empty__title">Nothing to compare yet</h2>
            <p className="small muted">
              Add a fund to each mix, or start from your portfolio.
            </p>
            <p className="small">
              <Link href="/">Build a portfolio</Link>
            </p>
          </div>
        ) : (
          result
        )}
      </section>

      {overlap && gap.suppressed.length === 0 ? (
        countries.status === "ready" && splits ? (
          <MarketSplitChart a={splits.a} b={splits.b} provider={provider} />
        ) : countries.status === "error" ? (
          notice(
            "The market split is not shown.",
            "The release's company domiciles could not be loaded. The overlap above does not depend on them.",
            "quiet",
          )
        ) : (
          <p className="small muted">Loading the company domiciles…</p>
        )
      ) : null}

      <p className="small">
        <Link href="/methodology/#overlap">How overlap is calculated</Link>
      </p>
    </div>
  );
}

function notice(
  title: string,
  body: string,
  tone: "alert" | "quiet" = "alert",
): ReactNode {
  return (
    <div className={tone === "alert" ? "notice notice--alert" : "notice notice--quiet"}>
      <p className="notice__icon" aria-hidden="true">
        {tone === "alert" ? "!" : "·"}
      </p>
      <div className="stack stack--tight">
        <p>
          <strong>{title}</strong>
        </p>
        <p className="small">{body}</p>
      </div>
    </div>
  );
}

/** The oldest filing date across both sides, as provenance for the numbers. */
function oldestFiling(funds: readonly { as_of: string }[]): string | null {
  let oldest: string | null = null;
  for (const fund of funds) {
    if (oldest === null || fund.as_of < oldest) oldest = fund.as_of;
  }
  return oldest;
}
