import Link from "next/link";

/**
 * The footer, and the not-advice notice that has to appear on every page.
 *
 * One muted line, not two paragraphs. The notice is a standing condition of reading the
 * numbers, so it belongs on every page at a size that does not compete with them; the full text
 * is one click away, and the site's own navigation already carries the rest.
 *
 * **The source phrase is its own constant** (`SOURCE_LINE`) because a later workstream extends
 * that list — the audit found it names N-CEN and N-CSR, which the pipeline never reads, and omits
 * the 10-K/10-Q cover pages, which it does. Keeping it separate means that correction is one
 * string, not a footer rewrite.
 */

/** What the numbers come from. Extended when the pipeline's source list changes. */
export const SOURCE_LINE = "Holdings from SEC Form N-PORT";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="shell site-footer__inner">
        <p className="notice-line">
          Not investment advice · <span data-source-line>{SOURCE_LINE}</span> · Not
          affiliated with or endorsed by the SEC or any fund issuer ·{" "}
          <Link href="/disclaimer/">Disclaimer</Link>
        </p>
        {/* The footer's own navigation duplicated the sidebar link for link, which is why it
         * is gone: two copies of the same six links on one page is a second place to maintain
         * and a second set of tab stops for a keyboard reader. */}
      </div>
    </footer>
  );
}
