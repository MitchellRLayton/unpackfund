import type { Metadata } from "next";

import Link from "next/link";

import { ReadingLayout, type ReadingSection } from "@/components/prose/ReadingLayout";
import { Term } from "@/components/prose/Term";
import {
  CONTACT_EMAIL,
  EFFECTIVE_DATE,
  JURISDICTION,
  LEGAL_COPY_VERSION,
  LEGAL_ENTITY,
  METHODOLOGY_VERSION,
} from "@/lib/legal";
import { pageMetadata } from "@/lib/metadata";

export const metadata: Metadata = pageMetadata({
  title: "UnpackFund — about and contact",
  description:
    "Who runs UnpackFund, where the data comes from, what it costs, and how to report a mistake.",
  path: "/about/",
});

const SECTIONS: readonly ReadingSection[] = [
  { id: "who", title: "Who runs it" },
  { id: "data", title: "Where the data comes from" },
  { id: "cost", title: "What it costs, and why" },
  { id: "mistakes", title: "Reporting a mistake" },
  { id: "limits", title: "Limits worth knowing" },
  { id: "elsewhere", title: "Elsewhere on this site" },
];

export default function AboutPage() {
  return (
    <ReadingLayout
      eyebrow="How it works"
      title="About UnpackFund"
      lede="UnpackFund shows what a fund actually holds, so you can see the companies underneath it. It is one person's free tool, built from public SEC filings, with no account, no tracking and no advertising."
      meta={`Effective ${EFFECTIVE_DATE} · copy ${LEGAL_COPY_VERSION}`}
      sections={SECTIONS}
    >
      <h2 id="who">Who runs it</h2>
      <p>
        {LEGAL_ENTITY}, in {JURISDICTION}. Not a company, not a registered investment
        adviser, and not affiliated with any fund issuer or with the SEC. There is one
        person behind the address below, and he reads everything sent to it.
      </p>

      <h2 id="data">Where the data comes from</h2>
      <p>
        Every holding, date and weight on this site comes from a fund&rsquo;s own{" "}
        <Term name="n-port">Form N-PORT</Term> filing on SEC EDGAR, filed quarterly.
        Nothing is estimated, scraped from a fund&rsquo;s marketing page, or bought from a
        data vendor. The method — the sources, the matching rule, the coverage bands and
        why some funds show no metrics at all — is written out at{" "}
        <Link href="/methodology/">the methodology page</Link>, currently version{" "}
        {METHODOLOGY_VERSION}. The words themselves are in the{" "}
        <Link href="/glossary/">glossary</Link>.
      </p>

      <h2 id="cost">What it costs, and why</h2>
      <p>
        Nothing. No account, no subscription, no advertising, no data sold. The site is
        static files behind a CDN, which is cheap enough that one person can carry it, and
        the data is public.
      </p>

      <h2 id="mistakes">Reporting a mistake</h2>
      <p>
        If a number looks wrong, the most useful thing you can send is the fund ticker,
        the figure you expected, and the filing you got it from —{" "}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. Data corrections are the
        one kind of email that always gets an answer, because a wrong number is worse than
        a missing one. How long a fix takes depends on whether the error is ours or the
        filing&rsquo;s.
      </p>

      <h2 id="limits">Limits worth knowing</h2>
      <p>
        Holdings arrive 60 to 150 days after the quarter they describe, so the site shows
        what a fund held, not what it holds today. A fund whose{" "}
        <Term name="coverage">coverage</Term> is below 60% of its weight has its
        concentration metrics withheld rather than shown against a partial view. And none
        of this is investment advice — <Link href="/disclaimer/">the disclaimer</Link>{" "}
        says what that means in plain words.
      </p>

      <h2 id="elsewhere">Elsewhere on this site</h2>
      <p>
        <Link href="/methodology/">Methodology</Link> ·{" "}
        <Link href="/glossary/">Glossary</Link> ·{" "}
        <Link href="/disclaimer/">Disclaimer</Link> ·{" "}
        <Link href="/privacy/">Privacy</Link> · <Link href="/terms/">Terms</Link>
      </p>
    </ReadingLayout>
  );
}
