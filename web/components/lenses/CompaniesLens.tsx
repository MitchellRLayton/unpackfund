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
 * Four rules are visible in the markup:
 *
 * 1. **The market edge is never colour alone.** Each row carries `data-tier`, which the
 *    design system turns into a 4px inset, *and* the two-letter country code and the tier
 *    in words. A reader on a monochrome print, or with any colour-vision deficiency, gets
 *    the same answer. A company whose country the release does not answer keeps its row
 *    and its weight and loses only the colour: its edge is dashed, its code reads "no
 *    code", and the tier cell says so.
 * 2. **The bar is drawn on one scale for the table** — set by the largest company — and
 *    that scale does not change when the table is filtered, so a filtered view is not
 *    silently re-scaled into looking like the whole portfolio. Inside the bar, the
 *    divisions are the funds that hold the position: the same numbers the Funds column
 *    and the source line carry.
 * 3. **Rank is a place in this table, not a rating.** It numbers the rows as they are
 *    listed and renumbers when the sort changes. Nothing here ranks a company against
 *    anything but the visitor's own weights.
 * 4. **Sorting and filtering are the view's, not the ledger's.** `sortBy` copies, the
 *    filter searches name, ticker, country code and tier word, and the export is the whole
 *    ledger — the caption says so, because a spreadsheet of 200 rows that looked like a
 *    filtered table of 12 would be a different answer.
 */

import { useMemo, useRef, useState } from "react";
import type { CSSProperties, FocusEvent, UIEvent } from "react";

import styles from "./CompaniesLens.module.css";
import {
  firstVisibleRow,
  ROW_HEIGHT,
  rowWindow,
  scrollTopForRow,
  VIEWPORT_HEIGHT,
} from "@/components/workspace/windowing";
import { TIER_AS_OF, TIER_CONVENTION, tierOf } from "@/lib/country-tier";
import { ledgerCsv, saveCsv } from "@/lib/export";
import { lensCsvName } from "./lens-csv";
import { formatCount, formatShare } from "@/lib/format";
import type { LedgerRow, LedgerSource } from "@/lib/types";
import type { LensProps } from "@/components/workspace/types";

import {
  CellNote,
  LensExport,
  LensLede,
  LensProblem,
  LensSection,
  LensState,
} from "./lens-chrome";
import { lensGateState } from "./lens-gate";
import { nextSort, sortBy, TIER_WORD, type SortState } from "./lens-math";

type CompanySortKey = "name" | "country" | "weight" | "funds";

const COLUMNS: Array<{
  key: CompanySortKey | null;
  label: string;
  numeric: boolean;
  /** The direction the first click on this column sorts in. */
  first: "ascending" | "descending";
}> = [
  { key: null, label: "Rank", numeric: true, first: "descending" },
  { key: "name", label: "Company", numeric: false, first: "ascending" },
  { key: "country", label: "Country, market", numeric: false, first: "ascending" },
  { key: "weight", label: "Weight", numeric: true, first: "descending" },
  { key: "funds", label: "Funds", numeric: true, first: "descending" },
  { key: null, label: "Weight, drawn", numeric: false, first: "descending" },
];

const COLUMN_LABEL: Record<CompanySortKey, string> = {
  name: "Company",
  country: "Country",
  weight: "Weight",
  funds: "Funds",
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

/** What one contributing source is called in a cell, a title, or a screen reader's list. */
function sourceWord(source: LedgerSource): string {
  return source.kind === "fund" ? source.ref : "held directly";
}

/**
 * Where each fund's segment starts and ends, as fractions of the row's whole width.
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
 * colour is reserved for the market tier and the coverage band, and two greys here would be
 * a distinction with no legend.
 */
function FundBar({ row, maxWeight }: { row: LedgerRow; maxWeight: number }) {
  const fill = maxWeight > 0 ? Math.max(0, row.weight) / maxWeight : 0;
  const sources = sourcesOf(row);
  const segments = barSegments(sources);

  return (
    <span className="rowbar">
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
            title={`${sourceWord(source)}: ${formatShare(source.weight)} of your whole portfolio`}
          />
        );
      })}
    </span>
  );
}

export function CompaniesLens({ model }: LensProps) {
  const gate = lensGateState(model);
  const ledger = model.ledger;
  const releaseAsOf = model.releaseAsOf ?? "unknown";
  const [sort, setSort] = useState<SortState<CompanySortKey>>({
    key: "weight",
    direction: "descending",
  });
  const [query, setQuery] = useState("");

  // The window, described in full in `windowing.ts`. `first` is the row at the top of the
  // *visible* area, not the top of the drawn area — the overscan is the difference. It is
  // view state and holds no ledger data: the table above it is the record, this is only
  // which slice of it is in the DOM.
  const [first, setFirst] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLTableSectionElement | null>(null);
  // The caption and the header scroll with the rows, and the caption is taller than several
  // rows, so `scrollTop` is not a row index until that height is subtracted. It is measured
  // from the DOM rather than assumed, because it changes with the width of the page.
  const bodyOffset = useRef(0);

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
            const tier = row.country ? TIER_WORD[tierOf(row.country)] : "no country";
            return (
              row.name.toLowerCase().includes(needle) ||
              (row.ticker ?? "").toLowerCase().includes(needle) ||
              code === needle ||
              tier.toLowerCase().includes(needle)
            );
          });
    return sortBy(matching, sort, COMPARE);
  }, [ledger, query, sort]);

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

  const totalWeight = ledger.rows.reduce((sum, row) => sum + row.weight, 0);
  const suppressed = ledger.funds.filter((fund) => fund.coverage_pct < 60);
  const sortLabel = COLUMN_LABEL[sort.key];
  const view = rowWindow({ count: visible.length, first });

  /**
   * How much of the scrolled content sits above the first body row — the caption, which is
   * taller than several rows, and the pinned header. Measured rather than assumed because
   * it changes with the width of the page, and refreshed on every scroll and focus rather
   * than cached, so it stays true when the caption reflows.
   */
  const measureBodyOffset = (node: HTMLDivElement) => {
    const body = bodyRef.current;
    if (!body) return 0;
    bodyOffset.current =
      body.getBoundingClientRect().top -
      node.getBoundingClientRect().top +
      node.scrollTop;
    return bodyOffset.current;
  };

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget;
    measureBodyOffset(node);
    const next = firstVisibleRow({
      scrollTop: node.scrollTop,
      bodyOffset: bodyOffset.current,
    });
    setFirst((current) => (current === next ? current : next));
  };

  /** Sorting and filtering replace the list, so the window returns to its first row. */
  const resetScroll = () => {
    const node = scrollRef.current;
    if (node) node.scrollTop = 0;
    setFirst(0);
  };

  /**
   * A row that takes focus is scrolled to, and the scroll moves the window.
   *
   * That is what keeps a keyboard working on a windowed table: rows outside the window are
   * not in the DOM, so a Tab walk would otherwise stop at the last drawn row. Focusing a
   * row in the overscan pulls the window forward, and the rows after it are drawn by the
   * time the next Tab arrives.
   */
  const onRowFocus = (event: FocusEvent<HTMLTableSectionElement>) => {
    const target = event.target as HTMLElement | null;
    const row = target?.closest("tr[data-index]");
    if (!row) return;
    const index = Number(row.getAttribute("data-index"));
    if (!Number.isFinite(index)) return;
    const node = scrollRef.current;
    if (!node) return;
    // Measured here too: a keyboard can reach the table before the first scroll has
    // happened, and an offset of zero would put the scroll a caption's height too high.
    const next = scrollTopForRow({
      index,
      scrollTop: node.scrollTop,
      clientHeight: node.clientHeight,
      bodyOffset: measureBodyOffset(node),
    });
    if (next !== null) node.scrollTop = next;
  };

  const exportCompanies = () => {
    saveCsv(
      ledgerCsv(ledger, { as_of: releaseAsOf }),
      // The same file name shape as the other four lenses, so a folder of exports
      // sorts by what it holds rather than by which component wrote it.
      lensCsvName("companies", new Date(), releaseAsOf),
    );
  };

  return (
    <div className="stack">
      <LensProblem model={model} />
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
            resetScroll();
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
        <div
          className={`table-wrap ${styles.window}`}
          ref={scrollRef}
          onScroll={onScroll}
          // The CSS and `windowing.ts` have to agree on the height of the window, so the
          // number lives in one place and the stylesheet reads it from here.
          style={{ "--companies-window": `${VIEWPORT_HEIGHT}px` } as CSSProperties}
        >
          <table className="tier-edge table" aria-rowcount={visible.length + 2}>
            <caption>
              One row per company: {formatCount(ledger.rows.length)}{" "}
              {ledger.rows.length === 1 ? "company" : "companies"} in all, largest weight
              first unless another column is sorted. Sorted by {sortLabel},{" "}
              {directionWords(sort.key, sort.direction)}. Every heading except Rank and
              the drawn bar is a button: choose it to sort by that column, choose it again
              to reverse. Rank numbers the rows as they are listed and renumbers with the
              sort — it is a place in this table, not a judgement about a company. Weight
              is a share of your whole portfolio, and the same company is counted once
              however many funds hold it. Funds is how many of your funds hold it; a
              company you also hold directly says so, and a direct holding is not a fund,
              so it is not in that count. The drawn bar is the weight on one scale for the
              table, set by the largest company in the ledger and unchanged by the filter;
              the divisions inside it are the funds that hold the position, widest part
              first, and each carries its own share of your mix. The left edge is the
              market tier — two-letter code in text, tier in words beside it — following
              the {TIER_CONVENTION}, as of {TIER_AS_OF}. A company whose domicile the
              release cannot answer keeps its row and its weight: its edge is dashed, its
              code reads &ldquo;no code&rdquo;, and its tier says why. The count and the
              order in this caption are the whole table&rsquo;s; the rows drawn are the
              ones in view, and scrolling draws the rest, so the row numbers stay the
              table&rsquo;s rather than the screen&rsquo;s. Press a company name to open
              it.
            </caption>
            <thead>
              <tr>
                {COLUMNS.map((column) => {
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
                          resetScroll();
                          setSort((current) => nextSort(current, key, column.first));
                        }}
                      >
                        {column.label}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody ref={bodyRef} onFocus={onRowFocus}>
              {view.topPad > 0 ? (
                <tr
                  aria-hidden="true"
                  style={{ height: view.topPad, background: "transparent" }}
                >
                  <td colSpan={COLUMNS.length} style={{ padding: 0, border: 0 }} />
                </tr>
              ) : null}
              {visible.slice(view.start, view.end).map((row, offset) => {
                const index = view.start + offset;
                const tier = row.country === null ? null : tierOf(row.country);
                const largest = sourcesOf(row)[0];
                return (
                  <tr
                    key={row.company_id}
                    data-index={index}
                    aria-rowindex={index + 2}
                    style={{ height: ROW_HEIGHT }}
                    data-tier={tier ?? undefined}
                    data-country-missing={row.country === null ? "true" : undefined}
                    onClick={() => model.openCompany(row.company_id)}
                  >
                    <td className="num">{formatCount(index + 1)}</td>
                    <th scope="row">
                      <button
                        type="button"
                        className="table__sort"
                        // One line, always: a name that wrapped would make its row taller
                        // than `ROW_HEIGHT` and every spacer after it would be wrong. The
                        // full name stays in the accessible name and the tooltip.
                        style={{
                          display: "block",
                          maxWidth: "22rem",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={row.name}
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
                          <span className="country-tag">{row.country}</span>
                          <CellNote>
                            {tier ? TIER_WORD[tier] : "no country answer"}
                          </CellNote>
                        </>
                      )}
                    </td>
                    <td className="num">{formatShare(row.weight)}</td>
                    <td className="num">
                      {row.holder_count > 0 ? formatCount(row.holder_count) : "—"}
                      {row.held_directly ? <CellNote>plus direct</CellNote> : null}
                    </td>
                    <td>
                      <FundBar row={row} maxWeight={maxWeight} />
                      <CellNote>
                        {largest
                          ? `via ${sourceWord(largest)}${
                              row.sources.length > 1
                                ? ` +${formatCount(row.sources.length - 1)}`
                                : ""
                            }`
                          : "no source"}
                      </CellNote>
                    </td>
                  </tr>
                );
              })}
              {view.bottomPad > 0 ? (
                <tr
                  aria-hidden="true"
                  style={{ height: view.bottomPad, background: "transparent" }}
                >
                  <td colSpan={COLUMNS.length} style={{ padding: 0, border: 0 }} />
                </tr>
              ) : null}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={3}>
                  {query.trim().length > 0 ? "Matching companies" : "All companies"}
                </th>
                <td className="num">{formatShare(totalWeight)}</td>
                <td className="num" />
                <td>
                  <CellNote>the rest of your mix is untraced weight or cash</CellNote>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </LensSection>
    </div>
  );
}
