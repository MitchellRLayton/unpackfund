import type { Metadata, Viewport } from "next";
import Link from "next/link";

import { LegalFooter } from "@/components/LegalFooter";
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
        <LegalFooter />
      </body>
    </html>
  );
}
