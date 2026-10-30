import type { Metadata } from "next";

import { LegalPage } from "@/components/LegalPage";
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

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy policy"
      updated={EFFECTIVE_DATE}
      version={LEGAL_COPY_VERSION}
      intro={
        <p>
          {LEGAL_ENTITY} operates UnpackFund at unpackfund.com. This page describes what
          the site stores and what it does not.
        </p>
      }
    >
      <h2>The short version</h2>
      <p>
        Your portfolio never reaches the server. It is stored in the part of the web
        address after the <code>#</code> symbol, which browsers do not send to any server,
        and the site uses no cookies, no accounts, no analytics, and no third-party
        scripts. I cannot see what you build, and there is no login to lose.
      </p>

      <h2>What the site stores, and where</h2>
      <p>
        Everything you type — tickers, weights — lives in the URL fragment (the text after{" "}
        <code>#</code>) and in the memory of the page you have open. The fragment is not
        transmitted to me or to anyone else; that is how the &ldquo;share this link&rdquo;
        feature works without a database. Closing the tab ends it.
      </p>
      <p>
        The site sets no cookies, writes nothing to <code>localStorage</code> or{" "}
        <code>sessionStorage</code>, and keeps no server-side session. If you save a link,
        the portfolio is in that link, so treat a shared link as you would a shared note:
        anyone with the link can see the portfolio in it.
      </p>

      <h2>What the server sees</h2>
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

      <h2>What I do not do</h2>
      <ul>
        <li>No accounts, no sign-in, no newsletter, no contact form.</li>
        <li>No advertising and no ad network.</li>
        <li>No analytics product, session recording, or fingerprinting.</li>
        <li>No third-party scripts on any page.</li>
        <li>No sale or sharing of personal information.</li>
        <li>
          No request for your name, email address, or any other detail — there is nowhere
          on the site to give one.
        </li>
      </ul>

      <h2>If you email me</h2>
      <p>
        Writing to {CONTACT_EMAIL} is the only way to send me anything, and it is always
        your choice. Your message is handled by my email provider under its own terms, and
        I keep it only as long as it takes to answer or to act on a correction. I do not
        add you to a list, and there is no newsletter.
      </p>

      <h2>Links out</h2>
      <p>
        Some pages link to SEC filings at <code>sec.gov</code> and, where relevant, to an
        issuer&rsquo;s own documents. Those sites have their own privacy policies and I do
        not control them.
      </p>

      <h2>Children</h2>
      <p>
        The site is not directed to children under 13, and I do not knowingly collect
        information from anyone.
      </p>

      <h2>Your choices and rights</h2>
      <p>
        Because I hold no personal data about you, there is generally nothing to access,
        correct, or delete. If you believe I do hold something — an email you sent me, for
        example — write to {CONTACT_EMAIL} and I will respond within 30 days. Depending on
        where you live you may have additional rights under laws such as the GDPR or the
        CCPA; the same address reaches me for those requests, and I do not discriminate
        against anyone for exercising a privacy right.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes materially, the effective date above changes with it, and
        the change appears in the site&rsquo;s public history. Prior versions remain
        readable there.
      </p>

      <h2>Contact</h2>
      <p>
        {CONTACT_EMAIL} · {LEGAL_ENTITY} · {JURISDICTION}
      </p>
    </LegalPage>
  );
}
