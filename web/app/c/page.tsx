import type { Metadata } from "next";

import { CompaniesSurface } from "@/components/company/CompaniesSurface";

/**
 * `/c/` — the companies directory, and the company detail it opens over itself.
 *
 * A static shell around one client surface. The open company is `#c_<company_id>`,
 * which is a fragment: the server renders no heading and no company, because the
 * address bar is the only place that state lives (`/c/` on its own is the
 * directory). Anything the server rendered into this element would be a second
 * source of truth for a company id, and a page that can disagree with its own URL.
 */
export const metadata: Metadata = {
  title: "UnpackFund — company directory",
  description:
    "Every company in the published release, searchable by name and ticker, with the funds that report it and where it is domiciled.",
};

export default function CompanyPage() {
  return (
    <main id="main" className="shell page">
      <CompaniesSurface />
    </main>
  );
}
