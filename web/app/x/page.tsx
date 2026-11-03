import type { Metadata } from "next";

import { LedgerView } from "@/components/LedgerView";

export const metadata: Metadata = {
  title: "UnpackFund — X-Ray: your look-through",
};

export default function LedgerPage() {
  return (
    <main id="main">
      <LedgerView />
    </main>
  );
}
