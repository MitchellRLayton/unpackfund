import type { Metadata } from "next";

import { LegalPage } from "@/components/LegalPage";
import {
  CONTACT_EMAIL,
  EFFECTIVE_DATE,
  LEGAL_COPY_VERSION,
  LEGAL_ENTITY,
  METHODOLOGY_VERSION,
} from "@/lib/legal";

export const metadata: Metadata = {
  title: "UnpackFund — methodology",
  description:
    "How every number on UnpackFund is produced: sources, matching, coverage bands, freshness, and what the site does not do.",
};

export default function MethodologyPage() {
  return (
    <LegalPage
      title="Methodology"
      updated={EFFECTIVE_DATE}
      version={`${METHODOLOGY_VERSION} · copy ${LEGAL_COPY_VERSION}`}
      intro={
        <p>
          This page explains how every number on UnpackFund is produced, so a reader can
          decide how much to trust it. When the method changes, the version above changes,
          and the previous version stays readable in the site&rsquo;s public history.
        </p>
      }
    >
      <h2>Where the data comes from</h2>
      <p>
        Only from filings the US Securities and Exchange Commission publishes:{" "}
        <strong>Form N-PORT</strong> for fund holdings, <strong>Form N-CEN</strong> for
        fund identity and series, <strong>Form N-CSR</strong> and{" "}
        <strong>497K/485BPOS</strong> for fund documents, and SEC <strong>XBRL</strong>{" "}
        data for entity facts. Fund and company names are used descriptively. No issuer
        website, no vendor feed, and no scraped source contributes a number to this site.
      </p>

      <h2>What a &ldquo;holding&rdquo; is</h2>
      <p>
        A fund&rsquo;s N-PORT filing lists its positions with a value and a percentage of
        net assets. A fund that holds another fund is a holding like any other; the site
        does not guess what is inside it unless that fund files holdings of its own, in
        which case it has its own page.
      </p>

      <h2>How a holding becomes a company</h2>
      <p>
        Each position is matched to a company using identifiers in the filing and a
        deterministic, versioned matching process. A position that cannot be matched is
        counted as <strong>unmatched</strong> and stays visible as such: it is never
        dropped, back-filled from another source, or silently treated as zero.
      </p>

      <h2>Coverage, and why some pages withhold numbers</h2>
      <p>
        Coverage is the share of a fund&rsquo;s assets, by weight, that could be matched
        to a company. It decides what a fund page shows:
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Coverage</th>
            <th scope="col">What the page shows</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>70% or more</td>
            <td>Full metrics, with the coverage figure stated next to them.</td>
          </tr>
          <tr>
            <td>60% to 70%</td>
            <td>Metrics labelled partial, with the coverage figure stated.</td>
          </tr>
          <tr>
            <td>Below 60%</td>
            <td>
              The holdings that were matched, and no concentration metrics — the page says
              the fund is not covered.
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        The thresholds are a product decision, not a statistical claim. Below 60%, a
        concentration number would describe the part of the portfolio I could read rather
        than the portfolio itself, and a reader would have no way to tell the difference.
      </p>

      <h2>Freshness</h2>
      <p>
        Every number carries its own dates: the fund&rsquo;s reporting period, the date
        the filing was filed, and the number of days between them. Holdings are quarterly,
        so a portfolio on this site typically describes a date{" "}
        <strong>60 to 150 days</strong> in the past. The site shows the age rather than
        hiding it.
      </p>

      <h2>What the site does not do</h2>
      <p>
        It does not show returns, prices, expense ratios, or performance rankings. It does
        not rank funds. It does not predict anything, and it does not tell anyone what to
        buy. It shows what funds hold, how concentrated that is, and how much of it could
        be read.
      </p>

      <h2>Corrections</h2>
      <p>
        If a number here disagrees with a fund&rsquo;s own filing, the filing is right.
        Write to {CONTACT_EMAIL} with the fund and the date, and I will correct the
        pipeline and note the correction.
      </p>

      <h2>Source attribution</h2>
      <p>
        Source: SEC EDGAR — Form N-PORT, Form N-CEN, Form N-CSR, 497K/485BPOS, and XBRL
        company facts. No SEC seal or logo is used, and the SEC has not reviewed,
        approved, or endorsed this site. {LEGAL_ENTITY} operates UnpackFund.
      </p>
    </LegalPage>
  );
}
