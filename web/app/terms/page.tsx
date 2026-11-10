import type { Metadata } from "next";

import Link from "next/link";

import { ReadingLayout, type ReadingSection } from "@/components/prose/ReadingLayout";
import {
  CONTACT_EMAIL,
  EFFECTIVE_DATE,
  JURISDICTION,
  LEGAL_COPY_VERSION,
  LEGAL_ENTITY,
} from "@/lib/legal";
import { pageMetadata } from "@/lib/metadata";

export const metadata: Metadata = pageMetadata({
  title: "UnpackFund — terms of use",
  description: "The terms that apply to using UnpackFund.",
  path: "/terms/",
});

const SECTIONS: readonly ReadingSection[] = [
  { id: "licence", title: "Licence to use" },
  { id: "content", title: "Content" },
  { id: "warranty", title: "No warranty; limitation of liability" },
  { id: "law", title: "Governing law" },
  { id: "changes", title: "Changes" },
  { id: "contact", title: "Contact" },
];

export default function TermsPage() {
  return (
    <ReadingLayout
      eyebrow="Legal"
      title="Terms of use"
      lede="By using unpackfund.com you agree to these terms."
      meta={`Effective ${EFFECTIVE_DATE} · copy ${LEGAL_COPY_VERSION}`}
      sections={SECTIONS}
    >
      <h2 id="licence">Licence to use</h2>
      <p>
        You may read, link to, and cite this site. You may not resell it, present it as
        your own, or automate access in a way that degrades it for other people.
      </p>

      <h2 id="content">Content</h2>
      <p>
        The site&rsquo;s own text and code belong to {LEGAL_ENTITY}. The underlying data
        belongs to the public record it came from; see the{" "}
        <Link href="/methodology/">methodology</Link> for sources and attribution.
      </p>

      <h2 id="warranty">No warranty; limitation of liability</h2>
      <p>
        The site is provided &ldquo;as is&rdquo;, without warranty of any kind. To the
        extent permitted by law, {LEGAL_ENTITY} is not liable for any loss arising from
        use of the site or reliance on its contents. The full{" "}
        <Link href="/disclaimer/">disclaimer</Link> is part of these terms.
      </p>

      <h2 id="law">Governing law</h2>
      <p>{JURISDICTION}.</p>

      <h2 id="changes">Changes</h2>
      <p>
        The effective date above changes when these terms change, and the change appears
        in the site&rsquo;s public history.
      </p>

      <h2 id="contact">Contact</h2>
      <p>{CONTACT_EMAIL}</p>
    </ReadingLayout>
  );
}
