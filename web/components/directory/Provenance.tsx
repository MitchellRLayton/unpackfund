import Link from "next/link";
import type { ReactNode } from "react";

/**
 * What a directory lists, in one line, above the table (D-F-02, D-C-02).
 *
 * The release id and build date this line used to carry live in the sidebar's release badge, so
 * they are not said twice. The counts are the caller's, because the two directories phrase them
 * differently ("9,317 funds · 15,369 companies" and "15,369 companies across 9,317 funds"); the
 * link to how the numbers are made is the same.
 */
export function Provenance({ children }: { children: ReactNode }) {
  return (
    <p className="notice-line">
      {children} · <Link href="/methodology/">How it works</Link>
    </p>
  );
}
