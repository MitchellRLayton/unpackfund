import type { Metadata } from "next";

import { Panel } from "./panel";

/**
 * Prototype route — one open design question, throwaway code, never merged into
 * `main`'s product surface. Three variants of the same profitability panel, with
 * the highest-coverage measure (ROE) leading by default.
 */
export const metadata: Metadata = {
  title: "Profitability panel — prototype",
  robots: { index: false, follow: false },
};

export default function ProfitabilityPrototypePage() {
  return <Panel />;
}
