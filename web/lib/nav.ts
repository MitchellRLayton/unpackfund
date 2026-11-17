/**
 * The site's navigation model, and the one rule for "where am I".
 *
 * The data lives in `web/nav.json` because it has two readers: this module (for the
 * React shell) and `pipeline/pipeline/fund_pages.py` (for the 9,016 generated fund
 * pages, which ship no React). JSON rather than TypeScript so Python can load it
 * with `json.load` and no parser. `nav.test.ts` compares the two renderers' output,
 * which is what stops the copies drifting the way the old header nav did.
 *
 * `match` is a list of path prefixes and the first match wins, so no two entries may
 * overlap. `/` matches only itself: a bare prefix test would make every path match
 * the home entry.
 */

import raw from "../nav.json";

export interface NavItem {
  id: string;
  label: string;
  href: string;
  match: string[];
  icon?: string;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

export interface NavModel {
  groups: NavGroup[];
  footer: NavItem[];
  chrome: { search: string; menu: string; close: string };
}

export const NAV: NavModel = {
  groups: raw.groups as NavGroup[],
  footer: raw.footer as NavItem[],
  chrome: raw.chrome,
};

/** Every entry, groups first then footer, in the order the shell renders them. */
export const NAV_ITEMS: NavItem[] = [
  ...NAV.groups.flatMap((group) => group.items),
  ...NAV.footer,
];

/**
 * Does `pathname` belong to this entry?
 *
 * A section owns a path *segment*, not a string prefix: `/c` is Companies, but
 * `/compare` starts with the same two characters and used to light up both. The
 * trailing-slash forms are both accepted because `trailingSlash: true` means the
 * served path is `/compare/` while `usePathname` may hand back either.
 */
export function matches(item: NavItem, pathname: string | null): boolean {
  if (!pathname) return false;
  const path =
    pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return item.match.some((prefix) => {
    if (prefix === "/") return path === "/";
    return path === prefix || path.startsWith(`${prefix}/`);
  });
}

/** The entry the current path belongs to, or `null` for a page outside the nav. */
export function currentItem(pathname: string | null): NavItem | null {
  return NAV_ITEMS.find((item) => matches(item, pathname)) ?? null;
}

/** The top bar's title: the current section's label, or nothing. */
export function pageTitle(pathname: string | null): string | null {
  return currentItem(pathname)?.label ?? null;
}
