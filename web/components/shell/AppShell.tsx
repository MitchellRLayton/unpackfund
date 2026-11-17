"use client";

/**
 * The app shell: a sidebar, a page-scoped top bar, and the page.
 *
 * Every page template renders inside this — the twelve Next routes through
 * `web/app/layout.tsx`, and the 9,016 generated fund pages through the same markup
 * emitted by `pipeline/pipeline/fund_pages.py`. The two renderers read one nav model
 * (`web/nav.json`) and `nav.test.tsx` compares their output, because the previous
 * header was implemented twice by hand and the copies were already free to drift.
 *
 * The shell does not own `<main>`: each page renders its own, with its own classes,
 * so the skip link's target and the page's own layout are unchanged by the shell.
 *
 * `data-page` is the current section's id, and it exists for one rule: the Portfolio
 * keeps the drawer below 80rem instead of taking the icon rail, because the rail
 * leaves its 8-column Companies table 483px wide and the numbers clip mid-value
 * (measured 2026-11-17; the evidence is in docs/nav-migration/01/). Every other page
 * takes the rail at 64–80rem.
 */

import { usePathname } from "next/navigation";

import { currentItem } from "@/lib/nav";

import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const page = currentItem(pathname)?.id ?? "none";

  return (
    <div className="app-shell" data-page={page}>
      <Sidebar />
      <div className="app-body">
        <TopBar />
        <div className="app-main">{children}</div>
      </div>
    </div>
  );
}
