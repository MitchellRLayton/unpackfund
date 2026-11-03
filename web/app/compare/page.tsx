import type { Metadata } from "next";

import { CompareSurface } from "@/components/compare/CompareSurface";

/**
 * `/compare` — two mixes of funds, the companies they share, and where each sits.
 *
 * A static shell around one client surface: the comparison lives in the URL
 * fragment and nowhere else, so there is nothing for the server to render into it.
 * `metadata` is the only server-side content, which keeps the route in the export.
 */
export const metadata: Metadata = {
  title: "UnpackFund — compare two mixes",
  description:
    "Compare two mixes of funds: the share of each mix held in the same companies, the companies only one mix holds, and the market split of each, on one scale.",
};

export default function ComparePage() {
  return (
    <main id="main" className="shell page">
      <CompareSurface />
    </main>
  );
}
