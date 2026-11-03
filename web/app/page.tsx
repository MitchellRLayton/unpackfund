import type { Metadata } from "next";

import { IntroCurtain } from "@/components/intro/IntroCurtain";
import { Workspace } from "@/components/workspace/Workspace";

/**
 * `/` — the workspace.
 *
 * The same component as `/x/`, deliberately. Two routes, one surface: the portfolio and
 * the open lens live in the URL fragment, so a visitor who starts here and a visitor who
 * starts at `/x/` are looking at the same thing, and a link between the two cannot land
 * someone on a different page. The route only changes the title and the description a
 * link preview shows.
 */
export const metadata: Metadata = {
  title: "UnpackFund — see the companies behind your funds",
  description:
    "Add the funds you own and see the companies behind them: the share of each fund that could be traced to a company, the markets those companies are in, the overlap between funds, and the filing dates behind every number.",
};

export default function HomePage() {
  return (
    <main id="main">
      <Workspace />
      {/* `/` only, deliberately: `/x/` is the same surface reached by a link, and a
          visitor who followed a link has already been introduced. */}
      <IntroCurtain />
    </main>
  );
}
