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
  title: "UnpackFund — terms of use",
  description: "The terms that apply to using UnpackFund.",
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of use" updated={EFFECTIVE_DATE} version={LEGAL_COPY_VERSION}>
      <p>By using unpackfund.com you agree to these terms.</p>

      <h2>Licence to use</h2>
      <p>
        You may read, link to, and cite this site. You may not resell it, present it as
        your own, or automate access in a way that degrades it for other people.
      </p>

      <h2>Content</h2>
      <p>
        The site&rsquo;s own text and code belong to {LEGAL_ENTITY}. The underlying data
        belongs to the public record it came from; see the{" "}
        <a href="/methodology/">methodology</a> for sources and attribution.
      </p>

      <h2>No warranty; limitation of liability</h2>
      <p>
        The site is provided &ldquo;as is&rdquo;, without warranty of any kind. To the
        extent permitted by law, {LEGAL_ENTITY} is not liable for any loss arising from
        use of the site or reliance on its contents. The full{" "}
        <a href="/disclaimer/">disclaimer</a> is part of these terms.
      </p>

      <h2>Governing law</h2>
      <p>{JURISDICTION}.</p>

      <h2>Changes</h2>
      <p>
        The effective date above changes when these terms change, and the change appears
        in the site&rsquo;s public history.
      </p>

      <h2>Contact</h2>
      <p>{CONTACT_EMAIL}</p>
    </LegalPage>
  );
}
