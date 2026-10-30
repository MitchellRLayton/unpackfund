/**
 * The footer: the four clauses `compliance-licensing-guard` §6 requires on every
 * page, in short form, plus the way to reach the long form.
 *
 * It is a component rather than markup in `layout.tsx` so that a page can be
 * tested for it (`components/LegalFooter.test.tsx`) without rendering the shell.
 */
import Link from "next/link";

import styles from "./LegalFooter.module.css";

export function LegalFooter() {
  return (
    <footer className="site-footer">
      <div className={styles.inner}>
        <p className={styles.disclaimer}>
          <strong>UnpackFund is not investment advice.</strong> It is a free tool showing
          what funds hold, built from public SEC filings. It is not a recommendation to
          buy, hold, or sell any security, and the operator is not a registered investment
          adviser. Holdings come from quarterly filings and typically describe a portfolio{" "}
          <strong>60 to 150 days</strong> old; they can be wrong.{" "}
          <strong>Verify anything that matters</strong> against the fund&rsquo;s own
          documents.
        </p>
        <nav className={styles.links} aria-label="Legal">
          <Link href="/about/">About</Link>
          <Link href="/methodology/">Methodology</Link>
          <Link href="/disclaimer/">Disclaimer</Link>
          <Link href="/privacy/">Privacy</Link>
          <Link href="/terms/">Terms</Link>
        </nav>
        <p className={styles.attribution}>
          Source: SEC EDGAR (Form N-PORT, N-CEN, N-CSR, 497K/485BPOS, XBRL). No SEC seal
          or logo is used, and the SEC has not reviewed or endorsed this site. UnpackFund
          is not affiliated with any fund issuer.
        </p>
      </div>
    </footer>
  );
}
