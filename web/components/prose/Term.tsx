"use client";

import { useId, useSyncExternalStore, type ReactNode } from "react";

import { glossaryHref, glossaryTerm, type GlossaryTermId } from "@/lib/glossary";

import styles from "./Term.module.css";

/**
 * A word the site defines, with its definition a keystroke away.
 *
 * Three things are load-bearing here, and each one is a decision:
 *
 * 1. **The definition is in the document, not fetched.** It comes from
 *    `lib/glossary.ts`, so the popover and `/glossary/` cannot disagree, and a
 *    word with no definition is a typecheck error rather than an empty box.
 *
 * 2. **The browser does the work.** The open/close is the native popover
 *    (`popover` + `popovertarget`): Enter and Space activate a `<button>`, Escape
 *    closes the popover, a click outside dismisses it, focus returns to the
 *    button, and the element is drawn in the top layer so no ancestor can clip
 *    it. None of that is reimplemented in JavaScript, because a hand-rolled
 *    tooltip is where keyboard support usually goes to die.
 *
 * 3. **Without popover support, the word is a link.** Feature detection decides
 *    which element renders, through `useSyncExternalStore`: the server snapshot is
 *    "no", the client snapshot is the browser's own answer, and React re-renders
 *    after hydration if they differ. That is the same shape as any other
 *    environment-dependent value, and it avoids the two worse options — setting
 *    state in an effect (a cascading render for a fact that never changes) and
 *    reading the window during render (a hydration mismatch). A browser without
 *    `showPopover` gets a plain `<a>` to the glossary anchor, which works with the
 *    keyboard, with no JavaScript at all, and when the word is middle-clicked or
 *    copied.
 *
 * The popover element is a `<span>`, not a `<div>`, because it renders inside a
 * sentence: a `<p>` cannot contain a `<div>`, and an element that the HTML parser
 * would lift out of the paragraph is an element React and the parser disagree
 * about. It is out of flow (`position: absolute`, or `fixed` in the fallback)
 * once open, so a span behaves like the block it needs to be.
 *
 * Each instance anchors to its own word. The global sheet names the anchor
 * `--term` for every `.term`, which is fine with one definition on a page and
 * wrong with two: anchor positioning resolves a duplicated name to the last
 * element in document order, so the second popover would open under the tenth
 * word on the page. The inline `anchor-name`/`position-anchor` pair below is
 * unique per instance (from `useId`), and inline styles win over the sheet.
 */
export function Term({
  name,
  children,
}: {
  /** A term in `lib/glossary.ts`. A typo is a compile error. */
  name: GlossaryTermId;
  /** The words to show, when they differ from the term's label. */
  children?: ReactNode;
}) {
  const term = glossaryTerm(name);
  const instance = useSafeId();
  const enhanced = useSyncExternalStore(
    subscribeToNothing,
    supportsPopover,
    neverEnhanced,
  );

  // The registry is the type's source of truth, so this is unreachable for a
  // caller that compiles; the words still have to render if it ever happens.
  if (!term) return <>{children}</>;

  const label = children ?? term.label;
  const href = glossaryHref(name);

  if (!enhanced) {
    return (
      <a className="term" href={href}>
        {label}
      </a>
    );
  }

  const popoverId = `term-${name}-${instance}`;
  const anchorName = `--term-${name}-${instance}`;

  return (
    <>
      <button
        type="button"
        className="term"
        popoverTarget={popoverId}
        style={{ anchorName }}
      >
        {label}
      </button>
      <span
        id={popoverId}
        className={`popover ${styles.popover}`}
        popover="auto"
        role="note"
        style={{ positionAnchor: anchorName }}
      >
        <span className={styles.short}>{term.short}</span>
        <a className="popover__link" href={href}>
          Full definition
        </a>
      </span>
    </>
  );
}

/** The popover API, as this component needs to see it. */
type PopoverCapable = { showPopover?: unknown };

function supportsPopover(): boolean {
  return (
    typeof HTMLElement !== "undefined" &&
    typeof (HTMLElement.prototype as unknown as PopoverCapable).showPopover === "function"
  );
}

/**
 * The capability does not change while a page is open, so there is nothing to
 * subscribe to — but the store still needs a subscribe function to be a store,
 * and a component that never re-renders is the point.
 */
function subscribeToNothing(): () => void {
  return () => undefined;
}

/** The server, and the first client render before hydration, assume nothing. */
function neverEnhanced(): boolean {
  return false;
}

/**
 * `useId`'s string is a DOM id, not a CSS identifier: React has used `:r0:` and
 * now uses `«r0»`, and neither is legal in an `anchor-name`, whose grammar is
 * `--` followed by `[a-zA-Z0-9_-]`. Strip everything else — the remaining
 * characters are still unique per instance within the document.
 */
function useSafeId(): string {
  return useId().replace(/[^a-zA-Z0-9_-]/g, "");
}
