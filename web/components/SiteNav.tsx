"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Five sections, and which one you are on. The labels are the operator's words:
 * `/` is the Portfolio, `/x` is the X-Ray of it (2026-11-02). The URLs did not
 * move with the names — a shared link is older than a label.
 *
 * The current page is marked with `aria-current` as well as weight, because a
 * bold label alone is a colour-and-typography distinction that vanishes in a
 * screen reader.
 */
export function SiteNav() {
  const pathname = usePathname();
  // A section owns a path *segment*, not a string prefix: `/c` is Companies, but
  // `/compare` starts with the same two characters and used to light up both. The
  // background makes a second lit label impossible to miss, so the match has to be
  // the boundary (`SiteNav.test.tsx` holds this).
  const on = (raw: string) => {
    const prefix = raw !== "/" && raw.endsWith("/") ? raw.slice(0, -1) : raw;
    return prefix === "/"
      ? pathname === "/"
      : Boolean(pathname === prefix || pathname?.startsWith(`${prefix}/`));
  };

  return (
    <nav className="site-nav" aria-label="Sections">
      <Link href="/" aria-current={on("/") ? "page" : undefined}>
        Portfolio
      </Link>
      <Link href="/x/" aria-current={on("/x") ? "page" : undefined}>
        X-Ray
      </Link>
      <Link href="/compare/" aria-current={on("/compare") ? "page" : undefined}>
        Compare
      </Link>
      <Link href="/c/" aria-current={on("/c") ? "page" : undefined}>
        Companies
      </Link>
      <Link href="/funds/" aria-current={on("/funds") || on("/f/") ? "page" : undefined}>
        Funds
      </Link>
    </nav>
  );
}
