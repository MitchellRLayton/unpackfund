"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Two links, and which one you are on.
 *
 * The current page is marked with `aria-current` as well as weight, because a
 * bold label alone is a colour-and-typography distinction that vanishes in a
 * screen reader.
 */
export function SiteNav() {
  const pathname = usePathname();
  const onLedger = pathname?.startsWith("/x");

  return (
    <nav className="site-nav" aria-label="Sections">
      <Link href="/" aria-current={onLedger ? undefined : "page"}>
        Builder
      </Link>
      <Link href="/x/" aria-current={onLedger ? "page" : undefined}>
        Ledger
      </Link>
    </nav>
  );
}
