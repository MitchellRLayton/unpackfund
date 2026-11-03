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
 *
 * Input and wording are shared with the Portfolio page, not re-implemented here:
 * `lib/holdings.ts` turns a typed line into a holding or a sentence, and `tallyOf` turns
 * amounts into the total line. Two pages that each answered "is this a fund?" and "is
 * this 100%?" in their own words had already drifted — `/compare` refused a share class
 * the builder resolved and a stock it accepts — so the decision lives in one module and
 * this page only chooses what it allows (`allowSecurities: false`, `allowCash: false`)
 * and how to render the answer.
 */

import Link from "next/link";
import { useMemo, useState } from "react";

import { Notice } from "@/components/Notice";
import { AmountInput } from "@/components/AmountInput";
import { encodeComparison } from "@/lib/fragment";
import { deltaInkClass, formatCount, formatShare, formatWeightBp } from "@/lib/format";
import { resolveEntry, tallyOf, type Tally } from "@/lib/holdings";
import { buildOverlap } from "@/lib/overlap";
import { useComparison, type Side } from "@/lib/use-comparison";
import { useFunds, useRelease, useTickers, type LoadState } from "@/lib/use-release";
import type { FundDocument, FundWeight, ReleaseDescriptor } from "@/lib/types";

/** Rows rendered before the table asks to be told to render the rest. */
const ROW_PAGE = 200;

/**
 * One side of the comparison, and the only place this page takes input.
 *
 * The add path is the Portfolio page's, not a second one: `resolveEntry` decides what
 * was typed and hands back the sentence to show, so `/compare` and `/` refuse the same
 * input in the same words. Compare asks for funds only (`allowSecurities: false`,
 * `allowCash: false`) — a comparison is between what funds hold — but the refusal is
 * still a sentence, "AMZN is a stock, not a fund" or "Cash cannot be compared", each
 * pointing at the Portfolio page. Before this the side answered "AMZN is not in this
 * release", which was a claim the page had not checked and the wrong one.
 *
 * The amount line is `tallyOf`'s sentence rather than arithmetic here, for the same
 * reason: "fully allocated" / "12.00% unallocated" / "5.00% over 100%" are the builder's
 * exact words and must not fork. The `tally` itself is computed once by the page and
 * handed down, so the sentence a column shows and the gate that opens the overlap read
 * from the same object.
 */
function SideColumn({
  label,
  side,
  entries,
  tally,
  catalog,
  release,
  onAdd,
  onRemove,
  onWeight,
  onEqualise,
  onClear,
}: {
  label: string;
  side: Side;
  entries: FundWeight[];
  tally: Tally;
  catalog: string[];
  release: LoadState<ReleaseDescriptor>;
  onAdd: (side: Side, ticker: string) => void;
  onRemove: (side: Side, ticker: string) => void;
  onWeight: (side: Side, ticker: string, weightBp: number) => void;
  onEqualise: (side: Side) => void;
  onClear: (side: Side) => void;
}) {
  const [input, setInput] = useState("");
  // The decision's own tone/title/body, not a string: the shared module returns
  // presentation-ready words and both pages render the same three fields the same way.
  const [message, setMessage] = useState<{
    tone: "warn" | "info";
    title: string;
    body?: string;
  } | null>(null);
  // A submit may await the alias map or a symbol shard, and a second Enter while the
  // first is in flight must not add the holding twice.
  const [adding, setAdding] = useState(false);
  const heading = `side-${side}`;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const typed = input.trim();
    if (typed.length === 0 || adding) return;
    setAdding(true);
    try {
      const decision = await resolveEntry(
        typed,
        {
          catalog,
          release,
          // Fund-only, and said out loud: both of these are refusals with a reason, not
          // silently unavailable capabilities.
          allowSecurities: false,
          allowCash: false,
          where: label,
        },
        // Already-present keys are part of the decision, not a check above it: a
        // duplicate gets the same "already in" sentence the Portfolio page uses, with
        // the column named so a reader knows which side holds it.
        entries.map((entry) => entry.ticker),
      );
      if (!decision.ok) {
        setMessage({ tone: decision.tone, title: decision.title, body: decision.body });
        return;
      }
      // The resolved key, not what was typed: `VFIAX` adds `VOO`, the portfolio the
      // release actually publishes, exactly as the builder does.
      onAdd(side, decision.key);
      setInput("");
      setMessage(
        decision.body
          ? { tone: "info", title: `Added ${decision.label}`, body: decision.body }
          : null,
      );
    } finally {
      setAdding(false);
    }
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
        <button type="submit" className="primary" disabled={adding}>
          Add
        </button>
      </form>
      {message ? (
        <Notice
          tone={message.tone === "warn" ? "warn" : "accent"}
          title={message.title}
          role="status"
        >
          {message.body ? <p className="muted">{message.body}</p> : null}
        </Notice>
      ) : null}

      {entries.length === 0 ? (
        <p className="muted">No funds yet.</p>
      ) : (
        <>
          <ul className="portfolio-list">
            {entries.map((entry) => (
              <li key={entry.ticker}>
                <span className="ticker">{entry.ticker}</span>
                <AmountInput
                  label={`Portfolio weight for ${entry.ticker}`}
                  mode="bp"
                  amount={entry.weight_bp}
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
          {/* The builder's tally, word for word: the number, then the state in words,
            from the one function that defines both (`holdings.tallyOf`). A side that is
            short says how much is unallocated; a side past 100% says how far over; a side
            at exactly 100% says "fully allocated". Role=status so a weight edit is
            announced rather than silently changing the sentence. */}
          <p className="muted" role="status" style={{ fontSize: "0.85rem" }}>
            Total {formatWeightBp(tally.total)} {tally.sentence}.{" "}
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

  // The 100% rule and the words that state it come from `holdings.tallyOf`, the same
  // function the builder prints, so a side cannot be "complete" for the gate and
  // "12.00% unallocated" on screen. A side the visitor has not touched still tallies to
  // zero, and a zero side is not complete — which is correct: the overlap compares two
  // wholes, and one whole can never be empty.
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

  const bothSidesReady =
    tallyA.complete &&
    tallyB.complete &&
    sideATickers.length > 0 &&
    sideBTickers.length > 0 &&
    pending.length === 0 &&
    !error;

  const overlap = useMemo(() => {
    if (!bothSidesReady) return null;
    const sideFunds = (entries: FundWeight[]) =>
      entries
        .map((entry) => fundsByTicker.get(entry.ticker))
        .filter((fund): fund is FundDocument => Boolean(fund));
    const sideWeights = (entries: FundWeight[]) =>
      Object.fromEntries(entries.map((entry) => [entry.ticker, entry.weight_bp]));
    return buildOverlap({
      a: { funds: sideFunds(comparison.a), weightsBp: sideWeights(comparison.a) },
      b: { funds: sideFunds(comparison.b), weightsBp: sideWeights(comparison.b) },
    });
  }, [bothSidesReady, comparison.a, comparison.b, fundsByTicker]);

  const [limit, setLimit] = useState(ROW_PAGE);
  // Side A is already a v1 fragment, so the X-Ray is one link away rather than a
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
          tally={tallyA}
          catalog={catalog}
          release={release}
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
          tally={tallyB}
          catalog={catalog}
          release={release}
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
            The overlap opens at exactly 100%, the same gate as the X-Ray: the comparison
            is not scaled to fit, because a side that accounts for 60% of its value would
            make the overlap mean something else.
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
                weights. Δ is A minus B, in percentage points: green where A holds more of
                the company, red where B holds more, and an exact match reads —. The sign
                is printed beside every number, so the colour reinforces the direction
                rather than carrying it — a reader who cannot separate the two hues still
                reads + and −.
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
                    {/* The header abbreviation is the one place a screen reader would
                      otherwise hear a bare glyph with no direction, so the cell states
                      the subtraction, the units and the colour mapping in words. The
                      sign is in every cell and the caption says the same thing, which
                      is what keeps the ink reinforcement rather than meaning
                      (`static-xray-frontend` §4a, §8). */}
                    <span className="sr-only">
                      : A minus B, in percentage points, positive where A holds more and
                      negative where B holds more. Green where A holds more, red where B
                      holds more.
                    </span>
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
                    {/* The Δ cell wears the same sign ink as the ledger's bracket, from
                      the same function (`format.deltaInkClass`), so the two tables
                      cannot disagree about which side is green: green where A holds
                      more, red where B holds more, and `--muted` at a tie. The colour
                      never carries the fact — the sign is printed, the caption states
                      the mapping, and the header spells it out for a screen reader
                      (`static-xray-frontend` §4a, §8). A zero delta keeps this table's
                      own em dash rather than a signed 0.00%: the column is a difference,
                      and at a tie there is no side for a sign to name. */}
                    <td className="numeric">
                      <span className={deltaInkClass(row.delta)}>
                        {row.delta === 0
                          ? "—"
                          : `${row.delta > 0 ? "+" : "−"}${formatShare(Math.abs(row.delta))}`}
                      </span>
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
            <Link href="/x/">X-Ray</Link>: a company&apos;s weight is the sum of the funds
            holding it, times each fund&apos;s share of the portfolio.{" "}
            <Link href={ledgerHref}>Open A in the X-Ray</Link>.
          </p>
        </>
      ) : null}
    </>
  );
}
