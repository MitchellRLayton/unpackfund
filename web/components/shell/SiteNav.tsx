"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Five sections, and which one you are on.
 *
 * The redesign's information architecture: Portfolio is the workspace (`/` and
 * `/x/` are the same screen — `/x/` is the shared-link entry), and everything
 * else is a place you go to read rather than to compose. "How it works" is one
 * section holding Methodology, About, Glossary and the legal pages, because a
 * reader who wants to know how a number was made does not care which of four
 * documents it lives in.
 *
 * The current page is marked with `aria-current` as well as weight, because a
 * bold label alone is a distinction that vanishes in a screen reader.
 */
export function SiteNav() {
  const pathname = usePathname();
  // A section owns a path *segment*, not a string prefix: `/c` is Companies, but
  // `/compare` starts with the same two characters and used to light up both.
  const on = (raw: string) => {
    const prefix = raw !== "/" && raw.endsWith("/") ? raw.slice(0, -1) : raw;
    return prefix === "/"
      ? pathname === "/" || pathname === "/x" || pathname === "/x/"
      : Boolean(pathname === prefix || pathname?.startsWith(`${prefix}/`));
  };

  return (
    <nav className="site-nav" aria-label="Sections">
      <Link href="/" aria-current={on("/") ? "page" : undefined}>
        Portfolio
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
      <Link
        href="/methodology/"
        aria-current={
          on("/methodology") || on("/about") || on("/glossary") || on("/disclaimer")
            ? "page"
            : undefined
        }
      >
        How it works
      </Link>
    </nav>
  );
}
