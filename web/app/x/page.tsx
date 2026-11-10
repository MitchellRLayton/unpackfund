import type { Metadata } from "next";

import { Workspace } from "@/components/workspace/Workspace";
import { pageMetadata } from "@/lib/metadata";

/**
 * `/x/` — the look-through, at the URL it has always been at.
 *
 * The same component as `/`, not a copy of it: `/x/` is the address the product's name
 * comes from and the one older links point at, and a shared link has to open the same
 * surface whichever of the two it named. A visitor arriving here with a fragment sees
 * their portfolio immediately, because the fragment is the state and the route is not.
 */
export const metadata: Metadata = pageMetadata({
  title: "UnpackFund — X-Ray: your look-through",
  description:
    "The companies behind your funds, in one table: weights, the funds that hold each one, the market tier of every company, and the coverage and filing dates that qualify every number.",
  path: "/x/",
});

export default function XRayPage() {
  return (
    <main id="main">
      <Workspace />
    </main>
  );
}
