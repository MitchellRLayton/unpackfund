import type { Metadata } from "next";

import { FundDirectory } from "@/components/FundDirectory";

export const metadata: Metadata = {
  title: "UnpackFund — fund directory",
  description:
    "Every fund in the published release: its ticker, issuer and how much of it maps to companies.",
};

export default function FundsPage() {
  return (
    <main id="main">
      <FundDirectory />
    </main>
  );
}
