"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Five sections, and which one you are on.
 *
 * The current page is marked with `aria-current` as well as weight, because a
 * bold label alone is a colour-and-typography distinction that vanishes in a
 * screen reader.
 */
export function SiteNav() {
  const pathname = usePathname();
  const on = (prefix: string) =>
    prefix === "/" ? pathname === "/" : Boolean(pathname?.startsWith(prefix));

  return (
    <nav className="site-nav" aria-label="Sections">
      <Link href="/" aria-current={on("/") ? "page" : undefined}>
        Builder
      </Link>
      <Link href="/x/" aria-current={on("/x") ? "page" : undefined}>
        Ledger
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
