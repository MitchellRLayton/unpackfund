/**
 * One shell for the legal pages, so `/privacy`, `/terms`, `/disclaimer` and
 * `/methodology` cannot drift apart in heading size, measure, or dating.
 *
 * The pages are static export, so nothing here may read the network or the
 * clock: `updated` is a constant from `lib/legal.ts`, not `new Date()` — a build
 * that stamps "today" would claim a freshness the copy does not have.
 */
import type { ReactNode } from "react";

import styles from "./LegalPage.module.css";

export function LegalPage({
  title,
  updated,
  version,
  intro,
  children,
}: {
  title: string;
  updated: string;
  version?: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main id="main" className={styles.page}>
      <article className={styles.doc}>
        <h1>{title}</h1>
        <p className={styles.meta}>
          Effective {updated}
          {version ? ` · version ${version}` : null}
        </p>
        {intro ? <div className={styles.intro}>{intro}</div> : null}
        {children}
      </article>
    </main>
  );
}
