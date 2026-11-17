"use client";

/**
 * The page-scoped top bar.
 *
 * Iteration 1 gives it one job: say which section you are in, and carry the menu
 * button that opens the drawer below 64rem. The lens tabs and the page actions move
 * here in iteration 2, which is why the bar is a component with a slot rather than a
 * line in the layout.
 *
 * The title is a `<p>`, not a heading: every page already has its own `<h1>`, and a
 * second heading in the chrome would put "Portfolio" above "See the companies behind
 * your funds" in the document outline.
 */

import { usePathname } from "next/navigation";

import { NAV, pageTitle } from "@/lib/nav";

import { Icon } from "./Icon";

export function TopBar() {
  const pathname = usePathname();
  const title = pageTitle(pathname);

  return (
    <header className="app-topbar">
      <div className="app-topbar__inner">
        <button
          type="button"
          className="app-topbar__menu"
          popoverTarget="app-nav"
          aria-label="Open menu"
        >
          <Icon d={NAV.chrome.menu} />
        </button>
        {title ? <p className="app-topbar__title">{title}</p> : null}
        {/* The docked lens strip renders here, through a portal from the workspace.
         * The slot is always present and always the same height, so docking adds no
         * height to the bar and nothing below it moves. */}
        <div id="topbar-slot" className="app-topbar__slot" />
      </div>
    </header>
  );
}
