import type { Metadata } from "next";

import { Workspace } from "@/components/workspace/Workspace";
import { HOME_TITLE, pageMetadata } from "@/lib/metadata";

/**
 * `/` — the workspace.
 *
 * The same component as `/x/`, deliberately. Two routes, one surface: the portfolio and
 * the open lens live in the URL fragment, so a visitor who starts here and a visitor who
 * starts at `/x/` are looking at the same thing, and a link between the two cannot land
 * someone on a different page. The route only changes the title and the description a
 * link preview shows.
 */
export const metadata: Metadata = pageMetadata({
  title: HOME_TITLE,
  description:
    "Add the funds you own and see the companies behind them: the share of each fund that could be traced to a company, the markets those companies are in, the overlap between funds, and the filing dates behind every number.",
  path: "/",
});

export default function HomePage() {
  return (
    <main id="main">
      <Workspace />
    </main>
  );
}
