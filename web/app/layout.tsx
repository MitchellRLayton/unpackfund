import type { Metadata, Viewport } from "next";
import Link from "next/link";

import { SearchPalette } from "@/components/shell/SearchPalette";
import { SiteFooter } from "@/components/shell/SiteFooter";
import { SiteNav } from "@/components/shell/SiteNav";
import "./globals.css";

/**
 * The indexable flip is a build-time flag, not an edit.
 *
 * `--indexable` on the fund-page build flips 8,983 pages and writes the sitemap
 * and robots.txt; this is the third part of that package, and a crawler needs
 * all three to agree. Until the flag is set the whole site is `noindex, nofollow`.
 */
const INDEXABLE = process.env.NEXT_PUBLIC_INDEXABLE === "1";

export const metadata: Metadata = {
  title: "UnpackFund — see the companies behind your funds",
  description: "See the companies you actually own through your ETFs and mutual funds.",
  robots: { index: INDEXABLE, follow: INDEXABLE },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

/**
 * The shell: one header, one footer, and the page between them.
 *
 * The header is the only chrome the redesign adds, and it holds exactly two
 * things a reader needs from anywhere: where they are (the five sections) and a
 * way to jump to any fund or company (search, ⌘K). Everything else is the page.
 */
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="site-header">
          <div className="shell site-header__inner">
            <Link className="wordmark" href="/">
              UnpackFund
            </Link>
            <SiteNav />
            <div className="header-tools">
              <SearchPalette />
            </div>
          </div>
        </header>
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
