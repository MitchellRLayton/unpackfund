import type { Metadata, Viewport } from "next";
import Link from "next/link";

import { SiteNav } from "@/components/SiteNav";
import "./globals.css";

export const metadata: Metadata = {
  title: "UnpackFund",
  description: "See the companies you actually own through your ETFs and mutual funds.",
  // The release is a live preview while the pointer is non-production; nothing
  // here should be indexed until the operator promotes one.
  robots: { index: false, follow: false },
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
        <footer className="site-footer">
          <p>
            Holdings from SEC Form N-PORT filings. Not investment advice, and not a
            recommendation of any fund. UnpackFund is not affiliated with any fund issuer.
          </p>
        </footer>
      </body>
    </html>
  );
}
