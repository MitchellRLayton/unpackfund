import type { Metadata, Viewport } from "next";
import Link from "next/link";

import { LegalFooter } from "@/components/LegalFooter";
import { SiteNav } from "@/components/SiteNav";
import "./globals.css";

/**
 * The indexable flip is a build-time flag, not an edit.
 *
 * `--indexable` on the fund-page build flips 8,983 pages and writes the sitemap
 * and robots.txt; this is the third part of that package, and a crawler needs
 * all three to agree. Until the flag is set the whole site is `noindex, nofollow`
 * — the state it has been in since the scaffold, and the state the promotion
 * checklist keeps until the QA/SEO pass lands.
 */
const INDEXABLE = process.env.NEXT_PUBLIC_INDEXABLE === "1";

export const metadata: Metadata = {
  title: "UnpackFund",
  description: "See the companies you actually own through your ETFs and mutual funds.",
  robots: { index: INDEXABLE, follow: INDEXABLE },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

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
          <div className="site-header__inner">
            <Link className="wordmark" href="/">
              UnpackFund
            </Link>
            <SiteNav />
          </div>
        </header>
        {children}
        <LegalFooter />
      </body>
    </html>
  );
}
