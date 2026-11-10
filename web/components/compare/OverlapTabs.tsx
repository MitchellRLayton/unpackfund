"use client";

import { useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { formatCount, formatShare } from "@/lib/format";
import type { Overlap, OverlapRow } from "@/lib/overlap";

import styles from "./compare.module.css";
import {
  onlyRows,
  OVERLAP_SORT_DEFAULT,
  OVERLAP_SORT_LABEL,
  sharedRows,
  sortSharedRows,
  type OverlapSortKey,
  type Side,
  type SortDirection,
} from "./result";

/** Rows rendered before a table asks whether to show the rest. */
const PAGE = 100;

const TABS = [
  { id: "shared", label: "Shared" },
  { id: "only-a", label: "Only in A" },
  { id: "only-b", label: "Only in B" },
] as const;

type TabIndex = 0 | 1 | 2;

/**
 * The answer's three views, as one real tablist.
 *
 * The three tables are filterings of the same `buildOverlap` rows, not three
 * computations: "Shared" is both weights above zero, "Only in A" is A above zero
 * and B at zero, and the remaining tab is its mirror. They partition the rows, so
 * no company appears twice and the "In both" column adds up to the overlap printed
 * above them.
 *
 * Keyboard: one tab stop for the group, Left/Right move between tabs (wrapping),
 * Home/End to the ends, and selection follows focus — the WAI-ARIA pattern for
 * tabs. Each panel is labelled by its tab and is focusable, so a keyboard reader can
 * scroll a long table without hunting for it.
 */
export function OverlapTabs({
  overlap,
  sources,
}: {
  overlap: Overlap;
  sources: Record<Side, Map<string, string[]>>;
}) {
  const base = useId();
  const [selected, setSelected] = useState<TabIndex>(0);
  const [expanded, setExpanded] = useState(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // The Shared table's order is the reader's, not the page's: the three weights are
  // the three questions this table answers ("what does A hold most of", "what does B",
  // "what do they share"), and only the reader knows which one they came for. The
  // default is the overlap's own term, largest first, so the table still opens on the
  // answer the sentence above it states.
  const [sort, setSort] = useState<{
    key: OverlapSortKey;
    direction: SortDirection;
  }>({ key: "both", direction: "descending" });

  const shared = useMemo(
    () => sortSharedRows(sharedRows(overlap.rows), sort.key, sort.direction),
    [overlap, sort],
  );
  const onlyA = useMemo(() => onlyRows(overlap.rows, "a"), [overlap]);
  const onlyB = useMemo(() => onlyRows(overlap.rows, "b"), [overlap]);
  const rows = [shared, onlyA, onlyB] as const;
  const current = rows[selected];
  const visible = expanded ? current : current.slice(0, PAGE);

  function select(next: TabIndex) {
    setSelected(next);
    // The tables differ in height; a fresh tab starts at its own top rather than at
    // whatever row the previous one had scrolled to.
    setExpanded(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: TabIndex) {
    let next: TabIndex | null = null;
    if (event.key === "ArrowRight") next = ((index + 1) % TABS.length) as TabIndex;
    else if (event.key === "ArrowLeft")
      next = ((index + TABS.length - 1) % TABS.length) as TabIndex;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = (TABS.length - 1) as TabIndex;
    if (next === null) return;
    event.preventDefault();
    setSelected(next);
    setExpanded(false);
    tabRefs.current[next]?.focus();
  }

  /** Click a header to sort by it; click it again to reverse. */
  function toggleSort(key: OverlapSortKey) {
    setSort((previous) =>
      previous.key === key
        ? {
            key,
            direction: previous.direction === "descending" ? "ascending" : "descending",
          }
        : { key, direction: OVERLAP_SORT_DEFAULT },
    );
  }

  const ariaSort = (key: OverlapSortKey) => (sort.key === key ? sort.direction : "none");

  function caption(): string {
    if (selected === 0) {
      return `Both mixes hold ${formatCount(shared.length)} companies in common, of ${formatCount(overlap.unionCount)} held across the two. In both is the smaller of each company's two weights, and those are the numbers the overlap adds up. Sorted by ${OVERLAP_SORT_LABEL[sort.key]}, ${sort.direction === "descending" ? "largest first" : "smallest first"}.`;
    }
    if (selected === 1) {
      return `Mix A holds ${formatCount(onlyA.length)} companies that Mix B does not. Weight is each company's share of Mix A. Largest first.`;
    }
    return `Mix B holds ${formatCount(onlyB.length)} companies that Mix A does not. Weight is each company's share of Mix B. Largest first.`;
  }

  function emptySentence(): string {
    if (selected === 0) {
      return "No company is held by both mixes: nothing is shared, so the overlap is 0.00%.";
    }
    if (selected === 1) {
      return "No company is only in Mix A: everything Mix A holds, Mix B holds too.";
    }
    return "No company is only in Mix B: everything Mix B holds, Mix A holds too.";
  }

  const tabId = (index: number) => `${base}-tab-${index}`;
  const panelId = (index: number) => `${base}-panel-${index}`;

  return (
    <div className="stack stack--tight">
      <div className="tabs" role="tablist" aria-label="The overlap, by company">
        {TABS.map((tab, index) => (
          <button
            key={tab.id}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={tabId(index)}
            className="tab"
            aria-selected={index === selected}
            aria-controls={panelId(index)}
            tabIndex={index === selected ? 0 : -1}
            onClick={() => select(index as TabIndex)}
            onKeyDown={(event) => onKeyDown(event, index as TabIndex)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={panelId(selected)}
        aria-labelledby={tabId(selected)}
        tabIndex={0}
        className={styles.tabPanel}
      >
        {/* `aria-live` because the order is the answer to a click: a screen reader
         * that activates a sort button otherwise hears nothing change, and the arrow
         * is drawn in CSS where it cannot be announced. */}
        <p className="small muted" aria-live="polite">
          {caption()}
        </p>
        {visible.length === 0 ? (
          <p className="small">{emptySentence()}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Company</th>
                  {selected === 0 ? (
                    <>
                      {(["a", "b", "both"] as const).map((key) => (
                        <th
                          key={key}
                          scope="col"
                          className="num"
                          aria-sort={ariaSort(key)}
                        >
                          <button
                            type="button"
                            className="table__sort"
                            onClick={() => toggleSort(key)}
                          >
                            {OVERLAP_SORT_LABEL[key]}
                          </button>
                        </th>
                      ))}
                    </>
                  ) : (
                    <th scope="col" className="num">
                      {selected === 1 ? "In Mix A" : "In Mix B"}
                    </th>
                  )}
                  <th scope="col">Held through</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.company_id}>
                    <th scope="row">
                      {row.name}
                      {row.ticker ? (
                        <span className="mono muted"> {row.ticker}</span>
                      ) : null}
                    </th>
                    {selected === 0 ? (
                      <>
                        <td className="num">{formatShare(row.weightA)}</td>
                        <td className="num">{formatShare(row.weightB)}</td>
                        <td className="num">
                          {formatShare(Math.min(row.weightA, row.weightB))}
                        </td>
                      </>
                    ) : (
                      <td className="num">
                        {formatShare(selected === 1 ? row.weightA : row.weightB)}
                      </td>
                    )}
                    <td>
                      <HeldThrough row={row} sources={sources} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {current.length > PAGE && !expanded ? (
          <button type="button" className="btn btn--sm" onClick={() => setExpanded(true)}>
            Show all {formatCount(current.length)} companies
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Which funds a company arrives through, per side.
 *
 * "Held through VTI, VXUS" is the answer to the question the weight alone cannot
 * answer — the same 2% of a mix can come from one fund or six, and the difference is
 * the whole point of looking through them.
 */
function HeldThrough({
  row,
  sources,
}: {
  row: OverlapRow;
  sources: Record<Side, Map<string, string[]>>;
}) {
  const a = sources.a.get(row.company_id) ?? [];
  const b = sources.b.get(row.company_id) ?? [];
  if (a.length === 0 && b.length === 0) return <span className="muted">—</span>;
  return (
    <span className={styles.funds}>
      {a.length > 0 ? (
        <>
          <span className={styles.fundSide}>A</span>
          <span className={styles.fundList}>{a.join(", ")}</span>
        </>
      ) : null}
      {b.length > 0 ? (
        <>
          <span className={styles.fundSide}>B</span>
          <span className={styles.fundList}>{b.join(", ")}</span>
        </>
      ) : null}
    </span>
  );
}
