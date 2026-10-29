import type { Metadata } from "next";

import { CompanyView } from "@/components/CompanyView";

export const metadata: Metadata = {
  title: "UnpackFund — who holds this company",
};

export default function CompanyPage() {
  return (
    <main id="main">
      <CompanyView />
    </main>
  );
}
