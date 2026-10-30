import type { Metadata } from "next";
import Link from "next/link";

import { LegalPage } from "@/components/LegalPage";
import {
  CONTACT_EMAIL,
  EFFECTIVE_DATE,
  JURISDICTION,
  LEGAL_COPY_VERSION,
  LEGAL_ENTITY,
  METHODOLOGY_VERSION,
} from "@/lib/legal";

export const metadata: Metadata = {
  title: "UnpackFund — about and contact",
  description:
    "Who runs UnpackFund, where the data comes from, what it costs, and how to report a mistake.",
};

export default function AboutPage() {
  return (
    <LegalPage
      title="About UnpackFund"
      updated={EFFECTIVE_DATE}
      version={LEGAL_COPY_VERSION}
      intro={
        <p>
          UnpackFund shows what a fund actually holds, so you can see the companies
          underneath it. It is one person&rsquo;s free tool, built from public SEC
          filings, with no account, no tracking and no advertising.
        </p>
      }
    >
      <h2>Who runs it</h2>
      <p>
        {LEGAL_ENTITY}, in {JURISDICTION}. Not a company, not a registered investment
        adviser, and not affiliated with any fund issuer or with the SEC. There is one
        person behind the address below, and he reads everything sent to it.
      </p>

      <h2>Where the data comes from</h2>
      <p>
        Every holding, date and weight on this site comes from a fund&rsquo;s own Form
        N-PORT filing on SEC EDGAR, filed quarterly. Nothing is estimated, scraped from a
        fund&rsquo;s marketing page, or bought from a data vendor. The method — the
        sources, the matching rule, the coverage bands and why some funds show no metrics
        at all — is written out at <Link href="/methodology">the methodology page</Link>,
        currently version {METHODOLOGY_VERSION}.
      </p>

      <h2>What it costs, and why</h2>
      <p>
        Nothing. No account, no subscription, no advertising, no data sold. The site is
        static files behind a CDN, which is cheap enough that one person can carry it, and
        the data is public.
      </p>

      <h2>Reporting a mistake</h2>
      <p>
        If a number looks wrong, the most useful thing you can send is the fund ticker,
        the figure you expected, and the filing you got it from —{" "}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. Data corrections are the
        one kind of email that always gets an answer, because a wrong number is worse than
        a missing one. How long a fix takes depends on whether the error is ours or the
        filing&rsquo;s.
      </p>

      <h2>Limits worth knowing before you rely on it</h2>
      <p>
        Holdings arrive 60 to 150 days after the quarter they describe, so the site shows
        what a fund held, not what it holds today. A fund that reports less than 60% of
        its holdings by weight has its concentration metrics withheld rather than shown
        against a partial view. And none of this is investment advice —{" "}
        <Link href="/disclaimer">the disclaimer</Link> says what that means in plain
        words.
      </p>

      <h2>Elsewhere on this site</h2>
      <p>
        <Link href="/methodology">Methodology</Link> ·{" "}
        <Link href="/disclaimer">Disclaimer</Link> · <Link href="/privacy">Privacy</Link>{" "}
        · <Link href="/terms">Terms</Link>
      </p>
    </LegalPage>
  );
}
