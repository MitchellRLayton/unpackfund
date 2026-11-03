import Link from "next/link";

/**
 * The footer, and the not-advice notice that has to appear on every page.
 *
 * The brief's rule is a *compact line* linking the full disclaimer, not the
 * four-sentence block the old footer carried: the notice is a standing condition
 * of reading the numbers, so it belongs on every page at a size that does not
 * compete with them, and the full text is one click away. The source line stays
 * because it is the provenance of every number on the site.
 */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="shell site-footer__inner">
        <p className="notice-line">
          <strong>Not investment advice.</strong> UnpackFund shows what funds hold, from
          public SEC filings. It is not a recommendation to buy, hold or sell anything.{" "}
          <Link href="/disclaimer/">Read the full disclaimer</Link>.
        </p>
        <p className="notice-line">
          Source: SEC EDGAR (Form N-PORT, N-CEN, N-CSR, 497K/485BPOS, XBRL). No SEC seal
          or logo is used, and the SEC has not reviewed or endorsed this site. UnpackFund
          is not affiliated with any fund issuer.
        </p>
        <nav className="footer-links" aria-label="About this site">
          <Link href="/methodology/">Methodology</Link>
          <Link href="/about/">About</Link>
          <Link href="/glossary/">Glossary</Link>
          <Link href="/disclaimer/">Disclaimer</Link>
          <Link href="/privacy/">Privacy</Link>
          <Link href="/terms/">Terms</Link>
        </nav>
      </div>
    </footer>
  );
}
