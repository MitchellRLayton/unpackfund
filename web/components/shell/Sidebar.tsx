"use client";

/**
 * The site's navigation, as a sidebar.
 *
 * One element serves three layouts — expanded column, icon rail, off-canvas drawer —
 * because two elements would mean two `<nav>` landmarks with the same name and a
 * screen reader reading the menu twice. The layout is CSS; this component only says
 * what is in the menu and which entry is current.
 *
 * The drawer is a **native popover**: `popover` here, `popovertarget` on the top
 * bar's menu button. Escape and an outside click close it with no JavaScript, which
 * is the only way it can work on the 9,016 generated fund pages — they ship no React
 * at all, and the same markup is emitted by `pipeline/pipeline/fund_pages.py`.
 *
 * The release badge reads what the page has already loaded (`useKnownRelease`) and
 * prints nothing when nothing has been loaded. It must not cause a fetch: a shell
 * that fetched the pointer on every page would turn a static site into one that
 * talks to the data host on `/methodology/`.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

import { NAV, matches } from "@/lib/nav";
import { useKnownRelease } from "@/lib/use-release";

import { Icon } from "./Icon";
import { SearchPalette } from "./SearchPalette";

/** Chevrons for the fold button: pointing left folds the column, pointing right opens it. */
const FOLD_ICON = {
  collapse: "M14.5 6.5 9 12l5.5 5.5",
  expand: "M9.5 6.5 15 12l-5.5 5.5",
};

export function Sidebar({
  collapsed = false,
  onToggle,
}: {
  /** Folded to the icon rail by the visitor (wide screens only; see `lib/nav-collapse`). */
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const pathname = usePathname();
  const release = useKnownRelease();

  return (
    <aside className="app-sidebar" id="app-nav" popover="auto" aria-label="Site">
      <div className="app-sidebar__head">
        <Link className="app-sidebar__brand" href="/">
          <span className="app-sidebar__brand-full">UnpackFund</span>
          <span className="app-sidebar__brand-mark" aria-hidden="true">
            UF
          </span>
        </Link>
        {onToggle ? (
          <button
            type="button"
            className="app-sidebar__fold"
            onClick={onToggle}
            aria-controls="app-nav"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <Icon d={collapsed ? FOLD_ICON.expand : FOLD_ICON.collapse} />
          </button>
        ) : null}
        <button
          type="button"
          className="app-sidebar__close"
          popoverTarget="app-nav"
          popoverTargetAction="hide"
          aria-label="Close menu"
        >
          <Icon d={NAV.chrome.close} />
        </button>
      </div>

      <div className="app-sidebar__search">
        <SearchPalette />
      </div>

      <nav className="app-nav" aria-label="Sections">
        {NAV.groups.map((group) => (
          <div className="app-nav__group" key={group.id}>
            <p className="app-nav__label">{group.label}</p>
            <ul>
              {group.items.map((item) => (
                <li key={item.id}>
                  <Link
                    className="app-nav__link"
                    href={item.href}
                    aria-current={matches(item, pathname) ? "page" : undefined}
                    // The rail hides the text with `display: none`, which also drops it
                    // from the accessibility tree; the label keeps the link named.
                    aria-label={item.label}
                    title={collapsed ? item.label : undefined}
                  >
                    {item.icon ? <Icon d={item.icon} className="app-nav__icon" /> : null}
                    <span className="app-nav__text">{item.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="app-sidebar__foot">
        {release ? (
          <p className="app-sidebar__release">
            Release <span className="app-sidebar__release-id">{release.as_of}</span>
          </p>
        ) : null}
        <nav className="app-nav app-nav--legal" aria-label="About and legal">
          <ul>
            {NAV.footer.map((item) => (
              <li key={item.id}>
                <Link
                  href={item.href}
                  aria-current={matches(item, pathname) ? "page" : undefined}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </aside>
  );
}
