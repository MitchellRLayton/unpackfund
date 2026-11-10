"use client";

/**
 * Companies: every company you own a piece of, once, with the funds that got you there.
 *
 * This is the table the rest of the page is a summary of. One row per company in the
 * finished ledger — the ledger has already added the same company up across every fund
 * that holds it, so a company in three funds appears once at its combined weight, and the
 * funds behind it are on the row rather than in three places. That is the whole product in
 * one table: the fund you bought is a route, and the companies are what you own.
 *
 * Five rules are visible in the markup:
 *
 * 1. **The market edge is never colour alone.** Each row carries `data-tier`, which the
 *    design system turns into a 4px inset, *and* the two-letter country code and the tier
 *    in words. A reader on a monochrome print, or with any colour-vision deficiency, gets
 *    the same answer. The tier in words sits under the code, except where the word *is*
 *    the code: a US company reads "US" once, not "US US", because the code has already
 *    answered the market. A company whose country the release does not answer keeps its
 *    row and its weight and loses only the colour: its edge is dashed, its code reads "no
 *    code", and the tier cell says so.
 * 2. **Every fund is named, never counted down to "+N".** The row lists each contributing
 *    fund with its share and wraps to fit them, so a twelve-fund position grows the row
 *    instead of hiding eleven funds behind a number (`static-xray-frontend` §6: a meaning
 *    behind hover is a meaning half the readers never get). The bar above the list is the
 *    same numbers on one scale, not a second source of truth.
 * 3. **The bar is drawn on one scale for the table** — set by the largest company — and
 *    that scale does not change when the table is filtered, so a filtered view is not
 *    silently re-scaled into looking like the whole portfolio.
 * 4. **Rank is a place in this table, not a rating.** It numbers the rows as they are
 *    listed and renumbers when the sort changes. Nothing here ranks a company against
 *    anything but the visitor's own weights.
 * 5. **Sorting, filtering and paging are the view's, not the ledger's.** `sortBy` copies,
 *    the filter searches name, ticker, country code and tier word, and the export is the
 *    whole ledger — the disclosure under the table says so, because a spreadsheet that
 *    looked like the page would be a different answer. The table pages at 50 rows rather than virtualizing
 *    (`static-xray-frontend` §8): a row whose fund list wraps has no fixed height, so a
 *    window would have to clip the very list rule 2 exists to show, and a real page keeps
 *    the table semantics a screen reader relies on instead of an `aria-rowindex` we
 *    maintain by hand.
 *
 * The VT columns are the comparison, not a second holding: `benchmarkDelta` and
 * `formatSignedShare` are ADR-0015's one place where two displayed weights are subtracted,
 * the sign is always printed, and a release with no benchmark drops both columns rather
 * than printing a column of zeros.
 *
 * **The caption is one line** (operator's instruction, 2026-11-03). It used to carry all
 * five rules above as prose — eight sentences between the heading and the first row, which
 * is a wall of text nobody reads and which pushed the table down the page. What stays in
 * the caption is what a reader needs *while looking at the rows*: what the table is, how it
 * is ordered, and what the comparison column is against. The rest is in the `<details>`
 * under the table, closed by default, which is the shape `/x` uses for its method block.
 * The operator accepted the cost in as many words — the caption is no longer a description
 * a screen reader announces with the table — so do not "restore" the long version for
 * accessibility: the disclosure is reachable by keyboard and by a screen reader, and it is
 * the only copy.
 */

import { useMemo, useState } from "react";

import { PAGE_SIZE, pageOf } from "@/components/directory/paging";
import { activeShare, type GateResult } from "@/lib/style-benchmark";
import { benchmarkDelta } from "@/lib/benchmark";
import { TIER_AS_OF, tierConvention, tierOf } from "@/lib/country-tier";
import { saveCsv } from "@/lib/export";
import {
  deltaInkClass,
  formatCount,
  formatPct1,
  formatShare,
  formatSignedShare,
} from "@/lib/format";
import type { LedgerRow, LedgerSource } from "@/lib/types";
import type { LensProps } from "@/components/workspace/types";

import styles from "./CompaniesLens.module.css";
import {
  CellNote,
  LensExport,
  LensLede,
  LensProblem,
  LensSection,
  LensState,
} from "./lens-chrome";
import { EffectiveHoldingsSummary } from "./EffectiveHoldingsSummary";
import { companiesCsv, lensCsvName } from "./lens-csv";
import { lensGateState } from "./lens-gate";
import { nextSort, sortBy, TIER_WORD, type SortState } from "./lens-math";
import { useProvider } from "./provider-preference";
import { flagEmoji } from "@/lib/country-flag";

type CompanySortKey = "name" | "country" | "weight" | "funds";

interface Column {
  /** `null` for a column that is not a sort: it prints and does not order. */
  key: CompanySortKey | null;
  label: string;
  numeric: boolean;
  /** The direction the first click on this column sorts in. */
  first: "ascending" | "descending";
  /** Only shown when the release publishes a benchmark (`static-xray-frontend` §4a). */
  benchmark?: boolean;
  /**
   * Only shown when the style gate passed (POC, `equity-style-benchmark-plan.md` §1).
   * A column whose existence depends on the portfolio is a column the *reader* asked
   * for by holding one style family, which is why it can appear and disappear.
   */
  style?: boolean;
}

/**
 * The columns, in order: your weight, then how it compares with the benchmark, then the
 * two columns that say where the weight came from. The VT pair sits between them because
 * the difference only reads as a difference next to the number it is against.
 */
const COLUMNS: Column[] = [
  { key: null, label: "Rank", numeric: true, first: "descending" },
  { key: "name", label: "Company", numeric: false, first: "ascending" },
  {
    key: "country",
    label: "Country, market",
    numeric: false,
    first: "ascending",
  },
  { key: "weight", label: "Your weight", numeric: true, first: "descending" },
  {
    key: null,
    label: "VT",
    numeric: true,
    first: "descending",
    benchmark: true,
  },
  {
    key: null,
    label: "Change vs VT",
    numeric: true,
    first: "descending",
    benchmark: true,
  },
  // POC: `Style bench.` keeps a short header so the table width is stable (§9.2); the
  // class name lives in the caption and the tooltip.
  { key: null, label: "Style bench.", numeric: true, first: "descending", style: true },
  {
    key: null,
    label: "Change vs style",
    numeric: true,
    first: "descending",
    style: true,
  },
  { key: "funds", label: "Held by", numeric: true, first: "descending" },
  { key: null, label: "From your funds", numeric: false, first: "descending" },
];

/**
 * The optional mixed-family hint (§1), behind its own flag and off by default.
 *
 * A gate that fails silently is right for the product — a column appearing and vanishing
 * with no explanation is worse than no column — but it is unhelpful while building the
 * feature, so the POC can turn one muted line on to see *why* it hid.
 */
function styleHintEnabled(): boolean {
  return process.env.NEXT_PUBLIC_STYLE_HINT === "1";
}

function styleHintText(gate: Extract<GateResult, { eligible: false }>): string {
  switch (gate.reason) {
    case "unclassified":
      return `Style benchmark needs every fund to be classified. Unclassified: ${gate.offenders.join(", ")}.`;
    case "mixed_family":
      return `Style benchmark needs every fund in one style family. Mixed: ${gate.offenders.join(", ")}.`;
    case "region_fail":
      return `Style benchmark needs each fund's holdings in its class's region. Outside: ${gate.offenders.join(", ")}.`;
    default:
      return "Style benchmark needs at least one fund.";
  }
}

const COLUMN_LABEL: Record<CompanySortKey, string> = {
  name: "Company",
  country: "Country",
  weight: "Your weight",
  funds: "Held by",
};

/** The caption says which sort is on in the column's own words, not "descending". */
function directionWords(
  key: CompanySortKey,
  direction: "ascending" | "descending",
): string {
  const ascending = direction === "ascending";
  if (key === "name" || key === "country") return ascending ? "A first" : "Z first";
  return ascending ? "smallest first" : "largest first";
}

const COMPARE: Record<CompanySortKey, (a: LedgerRow, b: LedgerRow) => number> = {
  name: (a, b) =>
    a.name.localeCompare(b.name) || a.company_id.localeCompare(b.company_id),
  country: (a, b) =>
    (a.country ?? "").localeCompare(b.country ?? "") || a.name.localeCompare(b.name),
  weight: (a, b) => a.weight - b.weight || a.name.localeCompare(b.name),
  funds: (a, b) => a.holder_count - b.holder_count || a.weight - b.weight,
};

/** Fund tickers on a row, largest contribution first — the ledger already orders them. */
function sourcesOf(row: LedgerRow): LedgerSource[] {
  return [...row.sources].sort((a, b) => b.weight - a.weight);
}

/**
 * What one contributing source is called: a fund's ticker, or the visitor's own position
 * marked as theirs. A direct holding is not a fund (ADR-0014), so it never wears a ticker
 * that could be mistaken for one.
 */
function sourceLabel(source: LedgerSource): string {
  return source.kind === "fund" ? source.ref : `${source.ref} (direct)`;
}

/**
 * Where each segment starts and ends, as fractions of the row's whole width.
 *
 * A module-level function rather than arithmetic in the component body: the running total
 * is a `let`, and `react-hooks/immutability` (React Compiler) treats a variable reassigned
 * in a component as a value that outlives render. Here there is no `let` at all — each
 * offset is the sum of the segments before it — so the rule has nothing to object to and
 * the arithmetic reads as what it is. The funds list is a handful of entries at most, so
 * the repeated sum costs nothing.
 */
function barSegments(
  sources: readonly LedgerSource[],
): Array<{ left: number; width: number }> {
  const weights = sources.map((source) => Math.max(0, source.weight));
  const whole = weights.reduce((sum, weight) => sum + weight, 0);
  if (whole <= 0) return weights.map(() => ({ left: 0, width: 0 }));
  return weights.map((weight, index) => {
    const before = weights.slice(0, index).reduce((sum, other) => sum + other, 0);
    return { left: before / whole, width: weight / whole };
  });
}

/**
 * The bar: the position's weight, divided into the funds that hold it.
 *
 * The filled part's length is the weight on the table's shared scale; inside it, each
 * segment's width is that fund's share of the position, so the segments always add up to
 * the fill. A 1px `--paper` border is the only thing separating one fund from the next:
 * colour is reserved for the market tier, the coverage band and the benchmark difference,
 * and two greys here would be a distinction with no legend.
 */
function FundBar({ row, maxWeight }: { row: LedgerRow; maxWeight: number }) {
  const fill = maxWeight > 0 ? Math.max(0, row.weight) / maxWeight : 0;
  const sources = sourcesOf(row);
  const segments = barSegments(sources);

  return (
    <span className={`rowbar ${styles.bar}`}>
      {sources.map((source, index) => {
        const segment = segments[index];
        if (!segment) return null;
        return (
          <span
            key={`${source.kind}:${source.ref}`}
            className="rowbar__fill"
            style={{
              left: `${segment.left * fill * 100}%`,
              width: `${segment.width * fill * 100}%`,
              borderRight:
                index < sources.length - 1 ? "1px solid var(--paper)" : undefined,
            }}
            title={`${sourceLabel(source)}: ${formatShare(source.weight)} of your whole portfolio`}
          />
        );
      })}
    </span>
  );
}

/**
 * Every fund that paid for this position, named with its share of the visitor's mix.
 *
 * A list rather than a sentence, because a reader counting funds and a screen reader
 * hearing "list, 3 items" both get the count from the structure. No truncation: the row
 * wraps instead, and the page is short enough to take the height (this is why the table is
 * paginated rather than windowed).
 */
function SourceList({ row }: { row: LedgerRow }) {
  const sources = sourcesOf(row);
  if (sources.length === 0) return <CellNote>no source</CellNote>;

  return (
    <ul className={styles.sources} aria-label={`Funds holding ${row.name}`}>
      {sources.map((source) => (
        <li className={styles.source} key={`${source.kind}:${source.ref}`}>
          <span className={styles.sourceName}>{sourceLabel(source)}</span>{" "}
          <span className={styles.sourceWeight}>{formatShare(source.weight)}</span>
        </li>
      ))}
    </ul>
  );
}

export function CompaniesLens({ model }: LensProps) {
  const { provider } = useProvider();
  const gate = lensGateState(model);
  const ledger = model.ledger;
  const releaseAsOf = model.releaseAsOf ?? "unknown";
  const [sort, setSort] = useState<SortState<CompanySortKey>>({
    key: "weight",
    direction: "descending",
  });
  const [query, setQuery] = useState("");
  // Pages are 1-based and clamped on the way out, so a filter that shortens the list while
  // the reader is on page 40 shows the last page instead of an empty table.
  const [page, setPage] = useState(1);

  // The largest company in the whole ledger, not in the filtered view: one scale for the
  // table, so filtering cannot rescale the bars into a different-looking portfolio.
  const maxWeight = useMemo(() => {
    if (!ledger) return 0;
    return ledger.rows.reduce((max, row) => Math.max(max, row.weight), 0);
  }, [ledger]);

  const visible = useMemo(() => {
    if (!ledger) return [];
    const needle = query.trim().toLowerCase();
    const matching =
      needle.length === 0
        ? ledger.rows
        : ledger.rows.filter((row) => {
            const code = (row.country ?? "").toLowerCase();
            const tier = row.country ? tierOf(row.country, { provider }) : null;
            const tierWord = tier ? TIER_WORD[tier] : "no country";
            return (
              row.name.toLowerCase().includes(needle) ||
              (row.ticker ?? "").toLowerCase().includes(needle) ||
              code === needle ||
              tierWord.toLowerCase().includes(needle)
            );
          });
    return sortBy(matching, sort, COMPARE);
  }, [ledger, query, sort, provider]);

  // Active share against VT, the same distance the style columns print against the style
  // benchmark: `½ Σ |yours − benchmark|` over the companies either side holds. Computed
  // above the early returns because hooks may not be called conditionally.
  const vtActiveShare = useMemo(() => {
    if (!ledger?.benchmark) return null;
    const portfolio: Record<string, number> = {};
    const vt: Record<string, number> = {};
    for (const row of ledger.rows) {
      portfolio[row.company_id] = row.weight;
      vt[row.company_id] = row.benchmark_weight ?? 0;
    }
    return activeShare(portfolio, vt);
  }, [ledger]);

  if (gate.kind === "blocked") {
    return <LensState title={gate.title} body={gate.body} />;
  }

  if (!ledger) {
    return (
      <LensState
        title="Working out the look-through"
        body="The ledger is adding the funds' filings up. This lens reads only the finished ledger, so it waits for it."
      />
    );
  }

  if (ledger.rows.length === 0) {
    return (
      <LensState
        title="No companies in this portfolio"
        body="No filing in this release placed any of the weight you entered. Check the tickers in the holdings pane — a fund the release cannot answer for is a fund whose holdings cannot be seen."
      />
    );
  }

  // Held as a value, not only as a flag: the caption and the disclosure both print the
  // benchmark's own ticker and name, and a boolean does not narrow `ledger.benchmark`.
  const benchmark = ledger.benchmark;
  const hasBenchmark = benchmark !== null;
  // The style gate's verdict lives on the model; `state` is non-null only when the flag is
  // on, the gate passed and the member benchmarks are loaded.
  const style = model.style?.state ?? null;
  const styleGate = model.style?.gate ?? null;
  // "You hold the benchmark" (§6, EFV-only): a column of zeros is not a comparison, so the
  // columns are replaced by one sentence rather than printed.
  const showStyleColumns = style !== null && !style.holdsBenchmark;
  const columns = COLUMNS.filter(
    (column) =>
      (!column.benchmark || hasBenchmark) && (!column.style || showStyleColumns),
  );
  const current = pageOf(visible, page, PAGE_SIZE);
  const totalWeight = ledger.rows.reduce((sum, row) => sum + row.weight, 0);
  const suppressed = ledger.funds.filter((fund) => fund.coverage_pct < 60);
  const sortLabel = COLUMN_LABEL[sort.key];

  /** Sorting and filtering replace the list, so the reader goes back to its first page. */
  const resetPage = () => setPage(1);

  const exportCompanies = () => {
    saveCsv(
      companiesCsv(ledger, releaseAsOf),
      // The same file name shape as the other four lenses, so a folder of exports
      // sorts by what it holds rather than by which component wrote it.
      lensCsvName("companies", new Date(), releaseAsOf),
    );
  };

  return (
    <div className="stack">
      <LensProblem model={model} />
      {/*
        First in the lens, above the lede and the filter, because it is the
        portfolio's answer rather than a note about the table: a reader who opens
        this tab is asking "what do I own", and a summary that sits below the filter
        box — where it started — needs a scroll to find and reads as table chrome.
      */}
      <EffectiveHoldingsSummary effective={ledger.effective} />

      <LensLede>
        Every company you own a piece of, once, with its weight in your portfolio, the
        number of funds that hold it, and where in the mix it came from. The same company
        held through three funds is one row.
      </LensLede>

      {suppressed.length > 0 ? (
        <p className="notice notice--quiet" role="status">
          {formatCount(suppressed.length)}{" "}
          {suppressed.length === 1 ? "fund is" : "funds are"} covered below 60% (
          {suppressed.map((fund) => fund.ticker).join(", ")}), so no concentration figure
          is shown for {suppressed.length === 1 ? "it" : "them"} anywhere. The weight{" "}
          {suppressed.length === 1 ? "it contributes" : "they contribute"} is a floor: it
          can only rise as coverage improves.
        </p>
      ) : null}

      <div className="field">
        <label className="field__label" htmlFor="companies-filter">
          Filter companies
        </label>
        <input
          id="companies-filter"
          className="field__input"
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            resetPage();
          }}
          placeholder="Company, ticker, country code, or market"
          aria-describedby="companies-filter-note"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="field__hint" id="companies-filter-note">
          Filters the table only. The export is the whole ledger.
        </p>
      </div>

      <LensSection
        title="Your companies"
        action={
          <LensExport label="every company in the ledger" onExport={exportCompanies} />
        }
      >
        <p className="small muted">
          {formatCount(visible.length)} of {formatCount(ledger.rows.length)} companies.
          Counted by company, not by fund: the weights in this table add up to the part of
          your portfolio a filing could place, {formatShare(totalWeight)} of the whole.
        </p>
        {/*
          Active share (§1): one line, two numbers, and only the ones that exist. VT's is
          always computed when the release publishes VT; the style one only when the gate
          passed.
        */}
        {hasBenchmark ? (
          <p className="small muted" data-style-active-share>
            Active share vs {benchmark.ticker}:{" "}
            <strong>{vtActiveShare === null ? "—" : formatPct1(vtActiveShare)}</strong>
            {style && !style.holdsBenchmark ? (
              <>
                {" "}
                · vs style: <strong>{formatPct1(style.activeShare)}</strong>
              </>
            ) : null}
          </p>
        ) : null}
        {/* §6: EFV-only, or any book that is its own benchmark. Words, not a column of
            zeros — the comparison has no distance to report. */}
        {style?.holdsBenchmark ? (
          <p className="notice notice--quiet" role="status" data-style-holds-benchmark>
            You hold the style benchmark. Your mix is {style.caption}, so every row would
            show a difference of zero and the style columns are not shown.
          </p>
        ) : null}
        {/* §1's optional hint, behind its own flag: a failed gate is otherwise silent. */}
        {!style && styleGate && !styleGate.eligible && styleHintEnabled() ? (
          <p className="small muted" data-style-hint>
            {styleHintText(styleGate)}
          </p>
        ) : null}
        <div className="table-wrap">
          <table className={`tier-edge table ${styles.compact}`}>
            {/*
              The caption is one line, on the operator's instruction (2026-11-03): the
              eight-sentence version that used to live here was a wall of text above the
              table, and nobody reads a wall of text. What a reader needs while looking at
              the rows is what the table is, how it is ordered, and what the comparison
              column is against; everything else — the column meanings, the bracket's
              direction and ink, the market tier's convention, the export's scope — is one
              click away in the disclosure under the table, which is the same shape `/x`
              uses for its method block (`static-xray-frontend` §4a, v1.0.27).
            */}
            <caption>
              One row per company. Sorted by {sortLabel},{" "}
              {directionWords(sort.key, sort.direction)}.
              {benchmark
                ? style && showStyleColumns
                  ? ` Benchmarks: ${benchmark.ticker} · ${style.caption}.`
                  : ` Benchmark: ${benchmark.ticker}.`
                : null}
            </caption>
            <thead>
              <tr>
                {columns.map((column) => {
                  const active = column.key !== null && sort.key === column.key;
                  if (column.key === null) {
                    return (
                      <th
                        key={column.label}
                        scope="col"
                        className={column.numeric ? "num" : undefined}
                      >
                        {column.label}
                      </th>
                    );
                  }
                  const key = column.key;
                  return (
                    <th
                      key={column.label}
                      scope="col"
                      className={column.numeric ? "num" : undefined}
                      aria-sort={active ? sort.direction : "none"}
                    >
                      <button
                        type="button"
                        className="table__sort"
                        onClick={() => {
                          setSort((current) => nextSort(current, key, column.first));
                          resetPage();
                        }}
                      >
                        {column.label}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {current.rows.map((row, offset) => {
                const tier =
                  row.country === null ? null : tierOf(row.country, { provider });
                // The rank is the row's place in the whole sorted table, not on its page.
                const rank = current.start + offset;
                const delta = benchmarkDelta(row.weight, row.benchmark_weight);
                // The style column's own pair. A company the style benchmark does not hold
                // is `0`, not `null`: the benchmark *is* the class's holdings, so absent
                // means zero weight — the same reading the VT column already uses.
                const styleWeight = style?.weights[row.company_id] ?? 0;
                const styleDelta = showStyleColumns
                  ? benchmarkDelta(row.weight, styleWeight)
                  : null;
                // The market in words, which is what a reader without the colour needs.
                // For a US company that word is the country code itself, so printing it
                // would read "US US": the code already answers the market, and the note is
                // dropped rather than repeated. Every other country keeps it, because "CH"
                // does not tell you the market and "Developed" does.
                const marketWord = tier ? TIER_WORD[tier] : "no country answer";
                const showMarket = marketWord !== row.country;
                return (
                  <tr
                    key={row.company_id}
                    data-tier={tier ?? undefined}
                    data-country-missing={row.country === null ? "true" : undefined}
                    onClick={() => model.openCompany(row.company_id)}
                  >
                    <td className="num">{formatCount(rank)}</td>
                    <th scope="row" className={styles.company}>
                      <button
                        type="button"
                        className="table__sort"
                        aria-label={`Open ${row.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          model.openCompany(row.company_id);
                        }}
                      >
                        {row.name}
                      </button>
                      {row.ticker ? <CellNote>{row.ticker}</CellNote> : null}
                    </th>
                    <td>
                      {row.country === null ? (
                        <>
                          <span className="country-tag">no code</span>
                          <CellNote>no country answer</CellNote>
                        </>
                      ) : (
                        <>
                          {/* The flag is derived from the code and is decoration: the
                            glyph is `aria-hidden` and a screen reader hears the code,
                            exactly as it does everywhere else on the site. Windows'
                            Segoe UI Emoji has no flag glyphs and draws the two boxed
                            letters, so the code is printed beside it and is the fact. */}
                          <span className="country-tag">
                            <span aria-hidden="true">{flagEmoji(row.country)}</span>{" "}
                            {row.country}
                          </span>
                          {showMarket ? <CellNote>{marketWord}</CellNote> : null}
                        </>
                      )}
                    </td>
                    <td className="num">{formatShare(row.weight)}</td>
                    {hasBenchmark ? (
                      <td className="num">
                        {row.benchmark_weight === null
                          ? "—"
                          : formatShare(row.benchmark_weight)}
                      </td>
                    ) : null}
                    {hasBenchmark ? (
                      <td className="num">
                        {delta === null ? (
                          "—"
                        ) : (
                          <span className={deltaInkClass(delta)}>
                            {formatSignedShare(delta)}
                          </span>
                        )}
                      </td>
                    ) : null}
                    {showStyleColumns ? (
                      <>
                        <td className="num">{formatShare(styleWeight)}</td>
                        <td className="num">
                          {styleDelta === null ? (
                            "—"
                          ) : (
                            <span className={deltaInkClass(styleDelta)}>
                              {formatSignedShare(styleDelta)}
                            </span>
                          )}
                        </td>
                      </>
                    ) : null}
                    <td className="num">
                      {row.holder_count > 0 ? formatCount(row.holder_count) : "—"}
                      {row.held_directly ? <CellNote>plus direct</CellNote> : null}
                    </td>
                    <td className={styles.fromFunds}>
                      <FundBar row={row} maxWeight={maxWeight} />
                      <SourceList row={row} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={3}>
                  {query.trim().length > 0 ? "Matching companies" : "All companies"}
                </th>
                <td className="num">{formatShare(totalWeight)}</td>
                {hasBenchmark ? <td className="num" /> : null}
                {hasBenchmark ? <td className="num" /> : null}
                {showStyleColumns ? <td className="num" /> : null}
                {showStyleColumns ? <td className="num" /> : null}
                <td className="num" />
                <td>
                  <CellNote>the rest of your mix is untraced weight or cash</CellNote>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/*
          The method, under the table and closed by default (operator's instruction,
          2026-11-03). It was a caption of eight sentences, read by nobody and pushing the
          rows down the page; the facts are the same and the shape is `/x`'s: the answer
          first, the explanation one click from it.
        */}
        <details className={`${styles.method} no-print`}>
          <summary>How to read this table</summary>
          <p className="small muted">
            <strong>Rank</strong> numbers the rows as they are listed and renumbers with
            the sort: it is a place in this table, not a judgement about a company.{" "}
            <strong>Your weight</strong> is a share of your whole portfolio, counted once
            per company however many funds hold it. <strong>Held by</strong> is how many
            of your funds report it; a company you also hold directly says so, because a
            direct holding is not a fund and is not in that count.{" "}
            <strong>From your funds</strong> names every fund that holds the position,
            largest part of your mix first, with each one&rsquo;s share — no fund is
            hidden behind a count — and the bar above the list is those same shares on one
            scale for the whole table, set by the largest company in it and unchanged by
            the filter.
          </p>
          {benchmark ? (
            <p className="small muted">
              <strong>{benchmark.ticker}</strong> is {benchmark.name}, the one benchmark
              this table compares against, and the {benchmark.ticker} column is the
              company&rsquo;s weight inside {benchmark.ticker}&rsquo;s own portfolio: not
              a share of your mix, and not how much of {benchmark.ticker} you hold. The
              bracket is your weight minus {benchmark.ticker}&rsquo;s, in percentage
              points — (-1.20%) means you hold 1.20 points less of the company than{" "}
              {benchmark.ticker} does. It is green above zero and red below it, with no
              colour at exactly zero, and the sign is always printed, so the colour is
              emphasis and never the only reading. A company {benchmark.ticker} does not
              hold reads 0.00% there, which is a fact about {benchmark.ticker}&rsquo;s
              filing rather than a missing number.
            </p>
          ) : null}
          <p className="small muted">
            <strong>The left edge</strong> is the market tier — two-letter code in text,
            tier in words beside it — following the {tierConvention(provider)}, as of{" "}
            {TIER_AS_OF}. A company whose domicile the release cannot answer keeps its row
            and its weight: its edge is dashed, its code reads &ldquo;no code&rdquo;, and
            its tier says why.
          </p>
          <p className="small muted">
            <strong>Paging</strong> changes which rows are on screen, never the count or
            the order. The <strong>export</strong> is the whole ledger — every row, not
            this page. Press a company name to open it.
          </p>
        </details>

        <div className={`${styles.pager} no-print`}>
          <p className="small muted" role="status">
            {current.total === 0 ? (
              "No company matches this filter."
            ) : (
              <>
                Showing rows {formatCount(current.start)}–{formatCount(current.end)} of{" "}
                {formatCount(current.total)} · page {formatCount(current.page)} of{" "}
                {formatCount(current.pages)}
              </>
            )}
          </p>
          <div className={styles.pager__buttons}>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              disabled={current.page <= 1}
              onClick={() => setPage(current.page - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              disabled={current.page >= current.pages}
              onClick={() => setPage(current.page + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </LensSection>
    </div>
  );
}
