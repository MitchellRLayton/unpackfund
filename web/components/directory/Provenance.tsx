import Link from "next/link";
import type { ReactNode } from "react";

import type { ReleaseDescriptor } from "@/lib/types";

/**
 * Where a directory's numbers come from, in one line, above the table.
 *
 * Rule 3 of the redesign is that limits are content: a page that lists 9,000 funds
 * has to say what the list is, which release built it, and which part of it is a
 * filing rather than a calculation — before the first number, at reading weight,
 * not in a footnote. The line is short because the footer already carries the
 * not-advice sentence; this one carries the provenance.
 */
export function Provenance({
  release,
  children,
}: {
  release: ReleaseDescriptor;
  children?: ReactNode;
}) {
  return (
    <p className="notice-line">
      Release <strong>{release.as_of}</strong>, built {release.generated_at.slice(0, 10)}{" "}
      UTC from each fund&apos;s own SEC N-PORT filing. {children}{" "}
      <Link href="/methodology/">How these numbers are made</Link>.
    </p>
  );
}
