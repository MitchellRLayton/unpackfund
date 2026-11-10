import type { Metadata } from "next";

import { FundsDirectory } from "@/components/directory/FundsDirectory";
import { pageMetadata } from "@/lib/metadata";

/**
 * `/funds/` — the fund directory.
 *
 * A static shell around one client surface: the catalogue is read from the
 * release at runtime (the pointer names its hash), and the URL carries no state,
 * so there is nothing here for the server to render but the metadata.
 */
export const metadata: Metadata = pageMetadata({
  title: "UnpackFund — fund directory",
  description:
    "Every fund in the published release, searchable by ticker, name and issuer, with how much of each fund's weight maps to a company we can identify.",
  path: "/funds/",
});

export default function FundsPage() {
  return (
    <main id="main" className="shell page">
      <FundsDirectory />
    </main>
  );
}
