import type { Metadata } from "next";

import { CompareView } from "@/components/CompareView";

export const metadata: Metadata = {
  title: "UnpackFund — compare two portfolios",
};

export default function ComparePage() {
  return (
    <main id="main">
      <CompareView />
    </main>
  );
}
