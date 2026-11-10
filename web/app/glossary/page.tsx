import type { Metadata } from "next";

import Link from "next/link";

import { ReadingLayout, type ReadingSection } from "@/components/prose/ReadingLayout";
import styles from "@/components/prose/Glossary.module.css";
import { GLOSSARY_ALPHABET, GLOSSARY_LETTERS, GLOSSARY_TERMS } from "@/lib/glossary";
import { EFFECTIVE_DATE, LEGAL_COPY_VERSION } from "@/lib/legal";
import { pageMetadata } from "@/lib/metadata";

export const metadata: Metadata = pageMetadata({
  title: "UnpackFund — glossary",
  description:
    "The words UnpackFund uses — coverage, look-through, HHI, effective number of companies, overlap — defined against the code that computes them.",
  path: "/glossary/",
});

/**
 * Every term the site uses in a particular way, in one place.
 *
 * Nothing here is written twice: the list, the anchors and the letter sections
 * all come from `lib/glossary.ts`, which is also what `<Term>` reads for its
 * popover. Add a term there and it appears here, in its letter, with an anchor
 * that the popover's link already points at.
 */
const SECTIONS: readonly ReadingSection[] = GLOSSARY_TERMS.map((term) => ({
  id: term.id,
  title: term.label,
}));

export default function GlossaryPage() {
  return (
    <ReadingLayout
      eyebrow="How it works"
      title="Glossary"
      lede="The words this site uses when a number needs explaining, defined the way the code computes them. Where a definition and a figure disagree, the figure is right and the definition is a bug."
      meta={`Effective ${EFFECTIVE_DATE} · copy ${LEGAL_COPY_VERSION}`}
      sections={SECTIONS}
    >
      <p>
        A word with a dotted underline in the prose opens the short version without
        leaving the sentence; the link under it comes here for the rest. Every entry says
        where the word appears, so a reader who met it on a number can find the number
        again.
      </p>
      <p>
        Definitions are checked against the code rather than against how the words are
        usually used, because a definition that reads well and describes a different
        denominator is a claim about somebody&rsquo;s money. The method behind the terms —
        sources, matching, the look-through arithmetic and its limits — is on the{" "}
        <Link href="/methodology/">methodology page</Link>.
      </p>

      <nav className={styles.index} aria-label="Jump to a letter">
        {GLOSSARY_ALPHABET.map((letter) => {
          const group = GLOSSARY_LETTERS.find((candidate) => candidate.letter === letter);
          return group ? (
            <a key={letter} className={styles.indexLink} href={`#${group.id}`}>
              {letter}
            </a>
          ) : (
            <span key={letter} className={styles.indexEmpty} aria-hidden="true">
              {letter}
            </span>
          );
        })}
      </nav>

      {GLOSSARY_LETTERS.map((group) => (
        <section key={group.letter} className={styles.letter} aria-labelledby={group.id}>
          <h2 id={group.id} aria-label={`Terms beginning with ${group.letter}`}>
            {group.letter}
          </h2>
          {group.terms.map((term) => (
            <div key={term.id} className={styles.entry}>
              <h3 id={term.id}>{term.label}</h3>
              <p>{term.definition}</p>
              {term.expert ? <p className={styles.appears}>{term.expert}</p> : null}
              <p className={styles.appears}>Where it appears: {term.appears}</p>
            </div>
          ))}
        </section>
      ))}
    </ReadingLayout>
  );
}
