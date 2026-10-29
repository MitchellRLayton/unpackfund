import type { Metadata } from "next";

import { PortfolioBuilder } from "@/components/PortfolioBuilder";

export const metadata: Metadata = {
  title: "UnpackFund — see the companies behind your funds",
};

export default function HomePage() {
  return (
    <main id="main" className="narrow">
      <PortfolioBuilder />
    </main>
  );
}
