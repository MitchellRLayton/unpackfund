import type { Metadata, Viewport } from "next";
import Link from "next/link";

import { SearchPalette } from "@/components/shell/SearchPalette";
import { SiteFooter } from "@/components/shell/SiteFooter";
import { SiteNav } from "@/components/shell/SiteNav";
import "./globals.css";
import "./intro.css";

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
        {/* The first-visit film has to hide the page before the first paint, and the
            decision needs storage, which only exists in the browser. This is the one
            place a blocking script earns its keep: it reads two marks and sets one
            attribute, and `components/intro/IntroCurtain.tsx` makes the real decision a
            few hundred milliseconds later with the tested policy in
            `lib/intro-session.ts`. If the two ever disagree the hint loses, at the cost of
            one frame. Keep the cooldown here in step with `COOLDOWN_MS`. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{
if(location.pathname!=="/"&&location.pathname!=="/index.html")return;
var m=/[?&]intro=(force|off)/.exec(location.search);
var play=false;
if(m&&m[1]==="force")play=true;
else if(!(m&&m[1]==="off")
&&!matchMedia("(prefers-reduced-motion: reduce)").matches
&&location.hash.length<2
&&!document.hidden
&&sessionStorage.getItem("unpackfund.intro.session")===null){
var d=new Date();
var day=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
play=localStorage.getItem("unpackfund.intro.day")!==day;
}
if(play)document.documentElement.dataset.intro="play";
}catch(e){}})();`,
          }}
        />
        <div id="intro-curtain" className="intro-curtain" />
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
