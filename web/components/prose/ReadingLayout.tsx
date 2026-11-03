import type { ReactNode } from "react";

import styles from "./ReadingLayout.module.css";

/**
 * The reading layout: one page title, one 68ch column of prose, and a table of
 * contents that a reader can use to skip rather than scroll.
 *
 * Everything visual already lives in `globals.css` — `.reading` is the two-column
 * grid, `.toc` is the sticky sidebar, `.prose` is the measure and the rhythm — so
 * this component adds structure, not style. What it adds is the part the CSS
 * cannot know:
 *
 * - **The TOC is written down, not scraped.** Each page passes the sections it
 *   actually renders. A test (`ReadingLayout.test.tsx`) renders every page and
 *   fails if a TOC link has no anchor in the same document, so the list cannot
 *   quietly drift away from the headings.
 * - **Anchors land below the sticky header.** `scroll-margin-top` on `.prose h2`
 *   and `h3` is the CSS half; the ids here are the other half, and they are the
 *   ones a shared link uses (`/glossary/#coverage`).
 * - **One `main` and one `h1` per page.** The layout owns `<main id="main">`,
 *   which is what the shell's skip link targets, and the page title is its `<h1>`
 *   so heading order starts where it should.
 *
 * The TOC is a list of ordinary links: it cannot trap focus, and below the
 * 60rem breakpoint the grid collapses to one column and the TOC sits above the
 * article instead of beside it (the sticky rule is turned off there — see the
 * module stylesheet).
 */
export interface ReadingSection {
  /** The anchor of the heading this links to, without the `#`. */
  id: string;
  /** The heading's text, as the reader sees it. */
  title: string;
  /** `3` for a sub-section: the entry is indented under the one above it. */
  depth?: 2 | 3;
}

export function ReadingLayout({
  eyebrow,
  title,
  lede,
  meta,
  sections,
  tocTitle = "On this page",
  children,
}: {
  /** The section of the site, e.g. "How it works". */
  eyebrow?: string;
  title: string;
  /** One paragraph under the title: what this page is for. */
  lede?: ReactNode;
  /** Effective date and version, or any other single line of provenance. */
  meta?: ReactNode;
  /** The headings this page renders, in order. */
  sections: readonly ReadingSection[];
  tocTitle?: string;
  children: ReactNode;
}) {
  return (
    <main id="main" className="page">
      <div className="shell">
        <header className={styles.header}>
          {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
          <h1 className="title">{title}</h1>
          {lede ? <p className="lede">{lede}</p> : null}
          {meta ? <p className={styles.meta}>{meta}</p> : null}
        </header>

        <div className="reading">
          <nav className="toc" aria-label="On this page">
            <p className="toc__title">{tocTitle}</p>
            <ul>
              {sections.map((section) => (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    className={section.depth === 3 ? styles.tocSub : undefined}
                  >
                    {section.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <article className="prose">{children}</article>
        </div>
      </div>
    </main>
  );
}
