"use client";

/**
 * `/compare`: two portfolios, and the companies that make them the same or different.
 *
 * The number the page leads with is the overlap, defined by the math skill as
 * `Σ min(w_A, w_B)` — the share of value held in the same companies on both sides.
 * It is not "how many tickers overlap": two different funds can hold 90% of the same
 * companies, and two portfolios of different share classes can hold exactly the same
 * companies at different weights.
 *
 * Nothing is renormalised. If a side does not total 100%, the page says so and shows
 * no overlap number, because `Σ min` over a portfolio that only accounts for 60% of
 * its value is not a smaller comparison — it is a different question.
 */

import Link from "next/link";
import { useMemo, useState } from "react";

import { Notice } from "@/components/Notice";
import { WeightInput } from "@/components/WeightInput";
import { encodeComparison } from "@/lib/fragment";
import { formatCount, formatShare } from "@/lib/format";
import { buildOverlap } from "@/lib/overlap";
import { useComparison, type Side } from "@/lib/use-comparison";
import { useFunds, useRelease, useTickers } from "@/lib/use-release";
import type { FundDocument, PortfolioEntry } from "@/lib/types";

/** Rows rendered before the table asks to be told to render the rest. */
const ROW_PAGE = 200;

function SideColumn({
  label,
  side,
  entries,
  totalBp,
  balanced,
  catalog,
  onAdd,
  onRemove,
  onWeight,
  onEqualise,
  onClear,
}: {
  label: string;
  side: Side;
  entries: PortfolioEntry[];
  totalBp: number;
  balanced: boolean;
  catalog: string[];
  onAdd: (side: Side, ticker: string) => void;
  onRemove: (side: Side, ticker: string) => void;
  onWeight: (side: Side, ticker: string, weightBp: number) => void;
  onEqualise: (side: Side) => void;
  onClear: (side: Side) => void;
}) {
  const [input, setInput] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const heading = `side-${side}`;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const ticker = input.trim().toUpperCase();
    if (!ticker) return;
    if (entries.some((entry) => entry.ticker === ticker)) {
      setMessage(`${ticker} is already in ${label}.`);
      return;
    }
    if (catalog.length > 0 && !catalog.includes(ticker)) {
      setMessage(`${ticker} is not in this release.`);
      return;
    }
    onAdd(side, ticker);
    setInput("");
    setMessage(null);
  }

  return (
    <section className="compare__side" aria-labelledby={heading}>
      <h2 id={heading}>{label}</h2>
      <form onSubmit={submit} className="field" noValidate>
        <label htmlFor={`${heading}-ticker`} className="sr-only">
          Fund ticker for {label}
        </label>
        <input
          id={`${heading}-ticker`}
          type="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={10}
          placeholder="Ticker"
          value={input}
          onChange={(event) => {
            setInput(event.target.value.toUpperCase());
            setMessage(null);
          }}
        />
        <button type="submit" className="primary">
          Add
        </button>
      </form>
      {message ? (
        <p className="row-note" role="status">
          {message}
        </p>
      ) : null}

      {entries.length === 0 ? (
        <p className="muted">No funds yet.</p>
      ) : (
        <>
          <ul className="portfolio-list">
            {entries.map((entry) => (
              <li key={entry.ticker}>
                <span className="ticker">{entry.ticker}</span>
                <WeightInput
                  ticker={entry.ticker}
                  weightBp={entry.weight_bp}
                  onChange={(weightBp) => onWeight(side, entry.ticker, weightBp)}
                />
                <button
                  type="button"
                  onClick={() => onRemove(side, entry.ticker)}
                  aria-label={`Remove ${entry.ticker} from ${label}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            {(totalBp / 100).toFixed(2)}% allocated
            {balanced ? "" : " — not 100%"}.{" "}
            <button type="button" onClick={() => onEqualise(side)}>
              Split equally
            </button>{" "}
            ·{" "}
            <button type="button" onClick={() => onClear(side)}>
              Clear
            </button>
          </p>
        </>
      )}
    </section>
  );
}

export function CompareView() {
  const comparison = useComparison();
  const release = useRelease();
  const tickers = useTickers(release.status === "ready" ? release.data : null);
  const catalog = tickers.status === "ready" ? tickers.data : [];

  const sideATickers = useMemo(
    () => comparison.a.map((entry) => entry.ticker),
    [comparison.a],
  );
  const sideBTickers = useMemo(
    () => comparison.b.map((entry) => entry.ticker),
    [comparison.b],
  );
  // Both sides in one request set: a fund in both portfolios is fetched once, and
  // `useFunds` keeps whatever it has already loaded.
  const allTickers = useMemo(
    () => [...new Set([...sideATickers, ...sideBTickers])],
    [sideATickers, sideBTickers],
  );
  const { funds, pending, error } = useFunds(
    release.status === "ready" ? release.data : null,
    allTickers,
  );

  const fundsByTicker = useMemo(() => {
    const map = new Map<string, FundDocument>();
    for (const fund of funds) map.set(fund.ticker, fund);
    return map;
  }, [funds]);

  const bothSidesReady =
    comparison.balanced.a &&
    comparison.balanced.b &&
    sideATickers.length > 0 &&
    sideBTickers.length > 0 &&
    pending.length === 0 &&
    !error;

  const overlap = useMemo(() => {
    if (!bothSidesReady) return null;
    const sideFunds = (entries: PortfolioEntry[]) =>
      entries
        .map((entry) => fundsByTicker.get(entry.ticker))
        .filter((fund): fund is FundDocument => Boolean(fund));
    const sideWeights = (entries: PortfolioEntry[]) =>
      Object.fromEntries(entries.map((entry) => [entry.ticker, entry.weight_bp]));
    return buildOverlap({
      a: { funds: sideFunds(comparison.a), weightsBp: sideWeights(comparison.a) },
      b: { funds: sideFunds(comparison.b), weightsBp: sideWeights(comparison.b) },
    });
  }, [bothSidesReady, comparison.a, comparison.b, fundsByTicker]);

  const [limit, setLimit] = useState(ROW_PAGE);
  // Side A is already a v1 fragment, so the ledger is one link away rather than a
  // re-entry of the same funds.
  const ledgerHref = useMemo(
    () =>
      comparison.a.length === 0 ? "/x/" : `/x/#${encodeComparison(comparison.a, [])}`,
    [comparison.a],
  );

  return (
    <>
      <h1>Compare two portfolios</h1>
      <p className="prose">
        Overlap is the share of value held in the same companies on both sides: for each
        company, the smaller of its two weights, added up. Two portfolios holding
        different funds can still own the same companies, and this is how much of them
        they share.
      </p>

      {comparison.problem ? (
        <Notice tone="warn" title="That link could not be opened">
          {comparison.problem}
        </Notice>
      ) : null}

      <div className="compare">
        <SideColumn
          label="Portfolio A"
          side="a"
          entries={comparison.a}
          totalBp={comparison.totalBp.a}
          balanced={comparison.balanced.a}
          catalog={catalog}
          onAdd={comparison.add}
          onRemove={comparison.remove}
          onWeight={comparison.setWeightBp}
          onEqualise={comparison.equalise}
          onClear={comparison.clear}
        />
        <SideColumn
          label="Portfolio B"
          side="b"
          entries={comparison.b}
          totalBp={comparison.totalBp.b}
          balanced={comparison.balanced.b}
          catalog={catalog}
          onAdd={comparison.add}
          onRemove={comparison.remove}
          onWeight={comparison.setWeightBp}
          onEqualise={comparison.equalise}
          onClear={comparison.clear}
        />
      </div>

      {comparison.a.length > 0 || comparison.b.length > 0 ? (
        <p>
          <button type="button" onClick={comparison.swap}>
            Swap A and B
          </button>{" "}
          <span className="muted">
            — the overlap is symmetric, the difference column is not.
          </span>
        </p>
      ) : null}

      {release.status === "error" ? (
        <Notice tone="error" title={release.error.message} detail={release.error.detail}>
          <p>Nothing was read, so there is nothing to compare.</p>
        </Notice>
      ) : null}

      {error ? (
        <Notice tone="error" title={error.message} detail={error.detail}>
          <p>Remove and re-add the fund, or reload the page, to try again.</p>
        </Notice>
      ) : null}

      {!bothSidesReady && !error ? (
        <Notice tone="info" title="Both sides need funds totalling 100%">
          <p>
            {pending.length > 0
              ? `Loading ${pending.join(", ")}…`
              : "Add at least one fund to each side and make each side total 100%."}{" "}
            The comparison is not scaled to fit: a side that accounts for 60% of its value
            would make the overlap mean something else.
          </p>
        </Notice>
      ) : null}

      {overlap ? (
        <>
          <h2>The overlap</h2>
          <div className="strip">
            <div className="strip__cell">
              <span className="strip__label">Shared companies</span>
              <span className="strip__value">{formatShare(overlap.overlap)}</span>
              <span className="strip__note">of portfolio value, held on both sides</span>
            </div>
            <div className="strip__cell">
              <span className="strip__label">Only in A</span>
              <span className="strip__value">{formatShare(overlap.onlyA)}</span>
              <span className="strip__note">
                {formatShare(overlap.ledgerA.metrics.resolved_weight)} of A resolved
              </span>
            </div>
            <div className="strip__cell">
              <span className="strip__label">Only in B</span>
              <span className="strip__value">{formatShare(overlap.onlyB)}</span>
              <span className="strip__note">
                {formatShare(overlap.ledgerB.metrics.resolved_weight)} of B resolved
              </span>
            </div>
            <div className="strip__cell">
              <span className="strip__label">Companies</span>
              <span className="strip__value">
                {formatCount(overlap.sharedCount)} of {formatCount(overlap.unionCount)}
              </span>
              <span className="strip__note">held by both, of all companies held</span>
            </div>
          </div>

          <p className="muted">
            Shared companies plus only-in-A is{" "}
            {formatShare(overlap.overlap + overlap.onlyA)} — exactly A&apos;s resolved
            weight. The rest of A did not map to a company, and it is reported as unmapped
            rather than spread across the companies that did.
          </p>

          <h2>Company by company</h2>
          <div className="table-wrap">
            <table className="ledger">
              <caption>
                The {formatCount(Math.min(limit, overlap.rows.length))} largest of{" "}
                {formatCount(overlap.rows.length)} companies, by the larger of the two
                weights. Δ is A minus B.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Company</th>
                  <th scope="col" className="numeric">
                    A
                  </th>
                  <th scope="col" className="numeric">
                    B
                  </th>
                  <th scope="col" className="numeric">
                    Δ
                  </th>
                </tr>
              </thead>
              <tbody>
                {overlap.rows.slice(0, limit).map((row) => (
                  <tr key={row.company_id}>
                    <th scope="row">
                      {row.name}
                      <span className="row-note">
                        {row.ticker ? `${row.ticker} · ` : ""}
                        {row.inBoth ? "both" : row.weightA > 0 ? "only A" : "only B"}
                      </span>
                    </th>
                    <td className="numeric">
                      {row.weightA > 0 ? formatShare(row.weightA) : "—"}
                    </td>
                    <td className="numeric">
                      {row.weightB > 0 ? formatShare(row.weightB) : "—"}
                    </td>
                    <td className="numeric">
                      {row.delta === 0
                        ? "—"
                        : `${row.delta > 0 ? "+" : "−"}${formatShare(Math.abs(row.delta))}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {overlap.rows.length > limit ? (
            <p>
              <button type="button" onClick={() => setLimit(overlap.rows.length)}>
                Show all {formatCount(overlap.rows.length)} companies
              </button>
            </p>
          ) : null}

          <p className="muted">
            Every number here comes from the same aggregation as the{" "}
            <Link href="/x/">ledger</Link>: a company&apos;s weight is the sum of the
            funds holding it, times each fund&apos;s share of the portfolio.{" "}
            <Link href={ledgerHref}>Open A as a ledger</Link>.
          </p>
        </>
      ) : null}
    </>
  );
}
