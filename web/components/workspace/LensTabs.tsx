"use client";

/**
 * The lens strip: five tabs that are also the portfolio's five headline numbers.
 *
 * This replaces the "What you own" card and the plain tab row with one control. The card
 * said what the portfolio owns; the tabs said which table you were looking at; both were
 * about the same five things, and the card sat between the reader and the tabs. Now each
 * tab carries its own number, so the answer and the way to the detail are the same
 * object.
 *
 * **One component, two densities.** The full strip lives at the top of the results
 * column. When it scrolls out of view, a compact text-only copy appears inside the top
 * bar — same `LENS_TABS`, same `model.lens`, same `setLens`. There is no second tab
 * implementation and no second source of truth: `aria-selected` on both reads the one
 * lens in the URL fragment.
 *
 * **Only one of the two is ever in the accessibility tree.** The full strip is
 * `aria-hidden` and `inert` while docked, and the docked copy is `aria-hidden` and
 * `inert` while the full strip is in view, so a keyboard user never meets two tab
 * sequences. The panel's `aria-labelledby` follows whichever one is live.
 *
 * **Docking adds no height.** The docked copy renders into a slot that already exists
 * inside the top bar, whose height is `--topbar-h` whether or not anything is in it. The
 * holdings pane's sticky top reads the same variable, so nothing below moves.
 *
 * The open lens is *not* React state. It lives in the URL fragment, because the address
 * bar is the only place this app is allowed to remember anything. `model.setLens` writes
 * the fragment; the store re-renders; `model.lens` reads it back. There is deliberately
 * no `useEffect` copying one into the other.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import { CompaniesLens } from "@/components/lenses/CompaniesLens";
import { FundsLens } from "@/components/lenses/FundsLens";
import { MarketsLens } from "@/components/lenses/MarketsLens";
import { OverlapLens } from "@/components/lenses/OverlapLens";
import { QualityLens } from "@/components/lenses/QualityLens";
import type { WorkspaceModel } from "@/lib/use-workspace";
import type { Lens } from "@/lib/view-fragment";

import { useWorkspaceActions } from "./actions";
import type { LensMetric } from "./metrics";
import { LENS_TABS } from "./types";
import styles from "./Workspace.module.css";

/** The panel's id. Stable, so every tab's `aria-controls` names an element that exists. */
const PANEL_ID = "lens-panel";
/** The explanation a disabled strip points at. */
const DISABLED_NOTE_ID = "lens-disabled-note";
/** The slot the docked copy renders into, inside the top bar. */
const TOPBAR_SLOT_ID = "topbar-slot";
/** The two densities' ids. Only one is ever in the accessibility tree, and a test needs
 * a way to say which it is looking at without relying on document order. */
const STRIP_ID = "lens-strip";
const DOCK_ID = "lens-dock";

function renderLens(model: WorkspaceModel) {
  switch (model.lens) {
    case "markets":
      return <MarketsLens model={model} />;
    case "funds":
      return <FundsLens model={model} />;
    case "overlap":
      return <OverlapLens model={model} />;
    case "quality":
      return <QualityLens model={model} />;
    case "companies":
    default:
      return <CompaniesLens model={model} />;
  }
}

/**
 * Which edges of a scroll container are hiding something.
 *
 * The strip hides its native scrollbar (a five-tab row with a visible bar at the right
 * end reads as a broken control, and on Windows the bar takes layout space), so the only
 * signal that there is more to the right is a fade. A fade that is always on would lie
 * when the tabs fit, so it is measured.
 */
function useOverflow(ref: React.RefObject<HTMLElement | null>) {
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const left = element.scrollLeft > 1;
      const right = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setEdges((previous) =>
        previous.left === left && previous.right === right ? previous : { left, right },
      );
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [ref]);

  return edges;
}

/**
 * The top bar's slot, read without a state update.
 *
 * The slot is in the document before this component mounts, so the client's first render
 * can find it; the server has no document and renders no portal. `useSyncExternalStore`
 * is the API for exactly that difference — a `useState` set from an effect would be a
 * second render for a value that never changes.
 */
function useTopbarSlot(): HTMLElement | null {
  const subscribe = useCallback(() => () => {}, []);
  const getSnapshot = useCallback(() => document.getElementById(TOPBAR_SLOT_ID), []);
  const getServerSnapshot = useCallback(() => null, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function LensTabs({
  model,
  metrics,
  disabled = false,
}: {
  model: WorkspaceModel;
  metrics: LensMetric[];
  /** True when there is no portfolio: the tabs are inert and say why. */
  disabled?: boolean;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [docked, setDocked] = useState(false);
  const slot = useTopbarSlot();
  const actions = useWorkspaceActions(model);

  const byId = useMemo(
    () => new Map(metrics.map((metric) => [metric.id, metric])),
    [metrics],
  );
  const stripEdges = useOverflow(stripRef);
  const dockEdges = useOverflow(dockRef);

  /**
   * Dock when the strip has gone under the top bar.
   *
   * `threshold: 0` is the crossing; the negative top `rootMargin` is the top bar's own
   * height, so the strip docks when it disappears *behind the bar* rather than when it
   * leaves the viewport — otherwise there is a band of scroll where the tabs are hidden
   * and the docked copy has not appeared yet.
   */
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || typeof IntersectionObserver === "undefined") return;
    const bar = document.querySelector(".app-topbar");
    const barHeight = bar ? Math.round(bar.getBoundingClientRect().height) : 0;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        setDocked(!entry.isIntersecting && entry.boundingClientRect.top < 0);
      },
      { threshold: 0, rootMargin: `-${barHeight}px 0px 0px 0px` },
    );
    observer.observe(strip);
    return () => observer.disconnect();
  }, []);

  /**
   * A docked tab switches the lens and puts the reader at the top of the new panel.
   *
   * Without the scroll, a reader who is 1,500 px down and clicks "Overlap" lands in the
   * middle of a table they have never seen. The offset is the top bar's height, so the
   * panel's first line sits just under the bar rather than behind it.
   */
  const selectDocked = useCallback(
    (id: Lens) => {
      model.setLens(id);
      const panel = panelRef.current;
      if (!panel) return;
      const bar = document.querySelector(".app-topbar");
      const barHeight = bar ? bar.getBoundingClientRect().height : 0;
      const top = panel.getBoundingClientRect().top + window.scrollY - barHeight - 8;
      const reduce =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
    },
    [model],
  );

  /**
   * Arrow keys, Home and End, in whichever density has focus.
   *
   * The buttons are found through the event's own target — a tab's parent is its
   * tablist — rather than a map of refs. A ref map would be read during render, which
   * the React Compiler rejects, and the DOM already knows the answer.
   */
  const move = (index: number) => {
    return (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const last = LENS_TABS.length - 1;
      let next: number | null = null;
      if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
      else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = last;
      if (next === null) return;
      event.preventDefault();
      const tab = LENS_TABS[next];
      if (!tab) return;
      model.setLens(tab.id);
      const buttons =
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
          '[role="tab"]',
        );
      buttons?.[next]?.focus();
    };
  };

  const nameOf = (metric: LensMetric | undefined, fallback: string): string =>
    metric?.sentence ?? fallback;

  const fade = (edges: { left: boolean; right: boolean }): string | undefined => {
    if (edges.left && edges.right) return "both";
    if (edges.right) return "right";
    if (edges.left) return "left";
    return undefined;
  };

  const dock =
    slot === null
      ? null
      : createPortal(
          <div
            id={DOCK_ID}
            className={styles.dock}
            data-docked={docked ? "true" : "false"}
            aria-hidden={docked ? undefined : true}
            inert={docked ? undefined : true}
          >
            <div
              ref={dockRef}
              className={styles.dockTabs}
              data-fade={fade(dockEdges)}
              role="tablist"
              aria-label="Lenses"
              aria-describedby={disabled ? DISABLED_NOTE_ID : undefined}
            >
              {LENS_TABS.map((tab, index) => {
                const metric = byId.get(tab.id);
                const selected = tab.id === model.lens;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    id={`lens-tab-dock-${tab.id}`}
                    className={styles.dockTab}
                    aria-selected={selected}
                    aria-controls={PANEL_ID}
                    aria-label={nameOf(metric, tab.label)}
                    tabIndex={selected ? 0 : -1}
                    disabled={disabled}
                    onClick={() => selectDocked(tab.id)}
                    onKeyDown={move(index)}
                  >
                    {tab.label}
                    {selected && metric?.value ? (
                      <span className={styles.dockValue}>{metric.value}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            <div className={styles.dockActions}>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void actions.copy()}
              >
                Share
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={actions.exportCsv}
                disabled={model.ledger === null}
              >
                Export CSV
              </button>
              <button type="button" className="btn btn--sm" onClick={actions.print}>
                Print
              </button>
            </div>
          </div>,
          slot,
        );

  return (
    <section className="stack">
      <div className={styles.stripWrap} data-fade={fade(stripEdges)}>
        <div
          ref={stripRef}
          id={STRIP_ID}
          className={styles.strip}
          role="tablist"
          aria-label="Lenses"
          aria-describedby={disabled ? DISABLED_NOTE_ID : undefined}
          aria-hidden={docked ? true : undefined}
          inert={docked ? true : undefined}
        >
          {LENS_TABS.map((tab, index) => {
            const metric = byId.get(tab.id);
            const selected = tab.id === model.lens;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`lens-tab-${tab.id}`}
                className={styles.stripTab}
                aria-selected={selected}
                aria-controls={PANEL_ID}
                aria-label={nameOf(metric, tab.label)}
                tabIndex={selected ? 0 : -1}
                disabled={disabled}
                onClick={() => model.setLens(tab.id)}
                onKeyDown={move(index)}
              >
                <span className={styles.stripLabel}>
                  {metric?.dot ? (
                    <span
                      className={styles.dot}
                      data-band={metric.dot.band}
                      aria-hidden="true"
                    />
                  ) : null}
                  {tab.label}
                </span>
                <span className={styles.stripValue}>
                  {metric?.value ?? (
                    <span className={styles.skeleton} aria-hidden="true" />
                  )}
                </span>
                <span className={styles.stripSub}>{metric?.sub ?? ""}</span>
              </button>
            );
          })}
        </div>
      </div>

      {disabled ? (
        <p id={DISABLED_NOTE_ID} className="small muted">
          Add a fund, a stock or cash and the five lenses open.
        </p>
      ) : null}

      <div
        ref={panelRef}
        role="tabpanel"
        id={PANEL_ID}
        aria-labelledby={
          docked ? `lens-tab-dock-${model.lens}` : `lens-tab-${model.lens}`
        }
        tabIndex={0}
        className={styles.lensPanel}
      >
        {renderLens(model)}
      </div>

      {dock}
    </section>
  );
}
