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
  title: "UnpackFund — disclaimer",
  description:
    "UnpackFund is not investment advice. Holdings data lags by 60 to 150 days and may be wrong.",
};

export default function DisclaimerPage() {
  return (
    <LegalPage title="Disclaimer" updated={EFFECTIVE_DATE} version={LEGAL_COPY_VERSION}>
      <h2>Not investment advice</h2>
      <p>
        UnpackFund is a free tool that shows what funds hold, built from public SEC
        filings. Nothing here is a recommendation, a solicitation, or a personalised
        suggestion to buy, hold, or sell any security, and nothing here is provided in a
        fiduciary capacity. I am not a registered investment adviser, broker-dealer, or
        tax professional, and no reader should treat this site as a substitute for advice
        from one.
      </p>

      <h2>Holdings data is old and may be wrong</h2>
      <p>
        Fund holdings come from quarterly Form N-PORT filings, so they typically describe
        a portfolio as it stood <strong>60 to 150 days</strong> before you read it.
        Filings are sometimes amended, mis-keyed, or filed late, and my parsing of them
        can be wrong. Coverage is incomplete: where a fund&rsquo;s holdings cannot be
        matched to enough of its assets, the site says so and withholds the metrics rather
        than showing a number it cannot stand behind.
      </p>
      <p>
        <strong>
          Verify anything that matters against the fund&rsquo;s own filings and documents
        </strong>{" "}
        before you act on it.
      </p>

      <h2>No affiliation, no endorsement</h2>
      <p>
        I am not affiliated with any fund, fund issuer, or index provider. Fund and
        company names are used descriptively, to say what a fund holds. No logo, seal, or
        badge of any issuer, of the SEC, or of any other agency appears here, and none of
        them has reviewed, approved, or endorsed this site.
      </p>

      <h2>Third-party names and marks</h2>
      <p>
        Fund, company, and index names appear because the product describes what those
        funds hold. They remain the trademarks of their owners. Their use here is
        nominative and does not suggest any affiliation, sponsorship, or endorsement.
      </p>

      <h2>No warranty; limitation of liability</h2>
      <p>
        The site is provided &ldquo;as is&rdquo;, without warranty of any kind, express or
        implied, including fitness for a particular purpose. To the extent permitted by
        law, {LEGAL_ENTITY} is not liable for any loss arising from use of the site or
        reliance on its contents. Governing law: {JURISDICTION}.
      </p>

      <h2>No offer</h2>
      <p>
        Nothing on this site is an offer to sell or a solicitation of an offer to buy any
        security, nor a recommendation of any security, fund, or strategy, in any
        jurisdiction.
      </p>

      <h2>Corrections and complaints</h2>
      <p>
        Errors: {CONTACT_EMAIL}, with the fund and the date. Trademark or copyright
        complaints: the same address, and they reach the operator the same day.
      </p>
    </LegalPage>
  );
}
