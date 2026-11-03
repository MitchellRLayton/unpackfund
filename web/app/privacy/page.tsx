import type { Metadata } from "next";

import { ReadingLayout, type ReadingSection } from "@/components/prose/ReadingLayout";
import {
  CONTACT_EMAIL,
  EFFECTIVE_DATE,
  JURISDICTION,
  LEGAL_COPY_VERSION,
  LEGAL_ENTITY,
} from "@/lib/legal";

export const metadata: Metadata = {
  title: "UnpackFund — privacy policy",
  description:
    "What UnpackFund stores, what the server sees, and why your portfolio never leaves your browser.",
};

const SECTIONS: readonly ReadingSection[] = [
  { id: "short", title: "The short version" },
  { id: "stores", title: "What the site stores, and where" },
  { id: "server", title: "What the server sees" },
  { id: "not-do", title: "What I do not do" },
  { id: "email", title: "If you email me" },
  { id: "links", title: "Links out" },
  { id: "children", title: "Children" },
  { id: "rights", title: "Your choices and rights" },
  { id: "changes", title: "Changes" },
  { id: "contact", title: "Contact" },
];

export default function PrivacyPage() {
  return (
    <ReadingLayout
      eyebrow="Legal"
      title="Privacy policy"
      lede={`${LEGAL_ENTITY} operates UnpackFund at unpackfund.com. This page describes what the site stores and what it does not.`}
      meta={`Effective ${EFFECTIVE_DATE} · copy ${LEGAL_COPY_VERSION}`}
      sections={SECTIONS}
    >
      <h2 id="short">The short version</h2>
      <p>
        Your portfolio never reaches the server. It is stored in the part of the web
        address after the <code>#</code> symbol, which browsers do not send to any server,
        and the site uses no cookies, no accounts, no analytics, and no third-party
        scripts. I cannot see what you build, and there is no login to lose.
      </p>

      <h2 id="stores">What the site stores, and where</h2>
      <p>
        Everything you type — tickers, weights — lives in the URL fragment (the text after{" "}
        <code>#</code>) and in the memory of the page you have open. The fragment is not
        transmitted to me or to anyone else; that is how the &ldquo;share this link&rdquo;
        feature works without a database. Closing the tab ends it.
      </p>
      <p>
        The site sets no cookies, keeps nothing in <code>IndexedDB</code>, and keeps no
        server-side session. It writes exactly two values to your browser&rsquo;s local
        storage, and both exist only to stop the first-visit animation from replaying: one
        is a mark in <code>sessionStorage</code> that says this session has already
        decided and disappears when you close the tab, and the other is the <em>date</em>{" "}
        of the last time the animation played, kept in <code>localStorage</code> so that
        it plays at most once a day. The date is built from your own clock, in your own
        time zone, and is the only thing stored &mdash; not a timestamp, not a count, not
        an identifier, and nothing about your portfolio. Neither value is ever sent
        anywhere. Clearing this site&rsquo;s data removes both. If you save a link, the
        portfolio is in that link, so treat a shared link as you would a shared note:
        anyone with the link can see the portfolio in it.
      </p>

      <h2 id="server">What the server sees</h2>
      <p>
        The site is served by Cloudflare Workers, and the data it reads is served by
        Cloudflare R2 at <code>data.unpackfund.com</code>. Like any web host, Cloudflare
        processes the request itself: the page address you asked for, your IP address,
        your browser&rsquo;s user-agent string, and the time. Because the portfolio lives
        after the <code>#</code>, the request Cloudflare sees does not contain your
        portfolio.
      </p>
      <p>
        Cloudflare may keep operational logs and aggregate traffic statistics under its
        own terms. I do not use them to identify anyone, and I do not join them to
        anything else. Cloudflare is the only infrastructure provider involved.
      </p>

      <h2 id="not-do">What I do not do</h2>
      <ul>
        <li>No accounts, no sign-in, no newsletter, no contact form.</li>
        <li>No advertising and no ad network.</li>
        <li>No analytics product, session recording, or fingerprinting.</li>
        <li>No third-party scripts on any page.</li>
        <li>
          No third-party requests at all: the fonts, styles, scripts and data come from
          unpackfund.com or its own data host, <code>data.unpackfund.com</code>.
        </li>
        <li>No sale or sharing of personal information.</li>
        <li>
          No request for your name, email address, or any other detail — there is nowhere
          on the site to give one.
        </li>
      </ul>

      <h2 id="email">If you email me</h2>
      <p>
        Writing to {CONTACT_EMAIL} is the only way to send me anything, and it is always
        your choice. Your message is handled by my email provider under its own terms, and
        I keep it only as long as it takes to answer or to act on a correction. I do not
        add you to a list, and there is no newsletter.
      </p>

      <h2 id="links">Links out</h2>
      <p>
        Some pages link to SEC filings at <code>sec.gov</code> and, where relevant, to an
        issuer&rsquo;s own documents. Those sites have their own privacy policies and I do
        not control them.
      </p>

      <h2 id="children">Children</h2>
      <p>
        The site is not directed to children under 13, and I do not knowingly collect
        information from anyone.
      </p>

      <h2 id="rights">Your choices and rights</h2>
      <p>
        Because I hold no personal data about you, there is generally nothing to access,
        correct, or delete. If you believe I do hold something — an email you sent me, for
        example — write to {CONTACT_EMAIL} and I will respond within 30 days. Depending on
        where you live you may have additional rights under laws such as the GDPR or the
        CCPA; the same address reaches me for those requests, and I do not discriminate
        against anyone for exercising a privacy right.
      </p>

      <h2 id="changes">Changes</h2>
      <p>
        If this policy changes materially, the effective date above changes with it, and
        the change appears in the site&rsquo;s public history. Prior versions remain
        readable there.
      </p>

      <h2 id="contact">Contact</h2>
      <p>
        {CONTACT_EMAIL} · {LEGAL_ENTITY} · {JURISDICTION}
      </p>
    </ReadingLayout>
  );
}
