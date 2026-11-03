"use client";

/**
 * The lens tabs, and the lens they switch to.
 *
 * The open lens is *not* React state. It lives in the URL fragment, because the address
 * bar is the only place this app is allowed to remember anything, and a lens that survived
 * a reload in one place and vanished in another would be two answers to "which tab am I
 * on". `model.setLens` writes the fragment; the store re-renders; `model.lens` reads it
 * back. There is deliberately no `useEffect` copying one into the other.
 *
 * The tablist is the ARIA tabs pattern with a roving tabindex: one tab is in the tab
 * sequence, the arrow keys move between them, and Home/End jump to the ends. Selecting a
 * tab also *focuses* it, which is what makes arrow-key movement feel like one control
 * rather than five buttons that each steal focus.
 */

import { useRef } from "react";

import { CompaniesLens } from "@/components/lenses/CompaniesLens";
import { FundsLens } from "@/components/lenses/FundsLens";
import { MarketsLens } from "@/components/lenses/MarketsLens";
import { OverlapLens } from "@/components/lenses/OverlapLens";
import { QualityLens } from "@/components/lenses/QualityLens";
import type { WorkspaceModel } from "@/lib/use-workspace";

import { LENS_TABS } from "./types";
import styles from "./Workspace.module.css";

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

export function LensTabs({ model }: { model: WorkspaceModel }) {
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});

  const select = (index: number) => {
    const tab = LENS_TABS[index];
    if (!tab) return;
    model.setLens(tab.id);
    tabs.current[tab.id]?.focus();
  };

  const active = LENS_TABS.findIndex((tab) => tab.id === model.lens);

  return (
    <section className="stack">
      <div className="tabs" role="tablist" aria-label="Lenses">
        {LENS_TABS.map((tab, index) => (
          <button
            key={tab.id}
            ref={(element) => {
              tabs.current[tab.id] = element;
            }}
            type="button"
            role="tab"
            id={`lens-tab-${tab.id}`}
            className="tab"
            aria-selected={tab.id === model.lens}
            aria-controls={`lens-panel-${tab.id}`}
            tabIndex={tab.id === model.lens ? 0 : -1}
            onClick={() => model.setLens(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") {
                event.preventDefault();
                select((Math.max(0, active) + 1) % LENS_TABS.length);
              } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                select((Math.max(0, active) - 1 + LENS_TABS.length) % LENS_TABS.length);
              } else if (event.key === "Home") {
                event.preventDefault();
                select(0);
              } else if (event.key === "End") {
                event.preventDefault();
                select(LENS_TABS.length - 1);
              }
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`lens-panel-${model.lens}`}
        aria-labelledby={`lens-tab-${model.lens}`}
        tabIndex={0}
        className={styles.lensPanel}
      >
        {renderLens(model)}
      </div>
    </section>
  );
}
