import type { Metadata, Viewport } from "next";
import Link from "next/link";

import { SearchPalette } from "@/components/shell/SearchPalette";
import { SiteFooter } from "@/components/shell/SiteFooter";
import { SiteNav } from "@/components/shell/SiteNav";
import { OG_IMAGE, SITE_NAME, SITE_URL } from "@/lib/metadata";
import "./globals.css";

/**
 * The indexable flip is a build-time flag, not an edit.
 *
 * `--indexable` on the fund-page build flips 8,983 pages and writes the sitemap
 * and robots.txt; this is the third part of that package, and a crawler needs
 * all three to agree. Until the flag is set the whole site is `noindex, nofollow`.
 */
const INDEXABLE = process.env.NEXT_PUBLIC_INDEXABLE === "1";

/**
 * The shell's metadata is the fallback, not the usual case: every route builds its own
 * card through `pageMetadata` (`web/lib/metadata.ts`), and this is what a page that
 * forgot — or a 404 — still shows when its link is pasted somewhere.
 *
 * `metadataBase` is what makes the card's relative image path absolute, which is the
 * form every crawler requires; without it Next drops the image and the card is text.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "UnpackFund — see the companies behind your funds",
  description: "See the companies you actually own through your ETFs and mutual funds.",
  robots: { index: INDEXABLE, follow: INDEXABLE },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: "UnpackFund — see the companies behind your funds",
    description: "See the companies you actually own through your ETFs and mutual funds.",
    url: SITE_URL,
    images: [
      {
        url: OG_IMAGE.path,
        width: OG_IMAGE.width,
        height: OG_IMAGE.height,
        alt: OG_IMAGE.alt,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "UnpackFund — see the companies behind your funds",
    description: "See the companies you actually own through your ETFs and mutual funds.",
    images: [OG_IMAGE.path],
  },
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
