"use client";

/**
 * The first-visit film, mounted once, on the landing page only.
 *
 * Three jobs, in this order:
 *
 * 1. **Decide.** `lib/intro-session.ts` owns the policy; this file only feeds it the
 *    marks, the clock, the URL and the motion preference. The decision is made in an
 *    effect, never during render, because storage and `matchMedia` do not exist on the
 *    server and a render-time read is a hydration mismatch.
 * 2. **Load late.** The film is a dynamic import, so a visitor who is not going to see it
 *    downloads none of it: no GSAP, no film code, no field data. That is the whole reason
 *    the intro can be 50 kB of animation without touching the page's first-load budget.
 * 3. **Get out of the way.** Whatever happens — finished, skipped, reduced motion, a
 *    failed chunk — the page is restored and the curtain removed. A film that traps the
 *    visitor behind a sheet of paper is worse than no film.
 *
 * The curtain element itself is painted by the server (`layout.tsx`), and this component
 * adopts it rather than creating a second one, so there is exactly one sheet of paper and
 * no flash between the two. It is opaque, which is why the page behind it needs no hiding
 * of its own: the film decides what the visitor sees, and it reveals the real page in
 * stages as its own paper fades.
 *
 * There is no state here on purpose. The whole sequence is one effect with a ref guard, so
 * a re-render cannot start a second film and nothing is set during render.
 */

import { useEffect, useRef } from "react";

import {
  LAST_KEY,
  SESSION_KEY,
  decideIntro,
  isDeepLink,
  markSeen,
  parseStamp,
  readKnob,
  safeStore,
} from "@/lib/intro-session";

/** The element `layout.tsx` paints, so the film adopts it instead of adding another. */
export const CURTAIN_ID = "intro-curtain";

export function IntroCurtain() {
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const session = safeStore(() => window.sessionStorage);
    const last = safeStore(() => window.localStorage);

    const decision = decideIntro({
      session: parseStamp(session.get(SESSION_KEY)),
      last: parseStamp(last.get(LAST_KEY)),
      now: Date.now(),
      reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      deepLink: isDeepLink(window.location.search, window.location.hash),
      knob: readKnob(window.location.search),
    });

    const host = document.getElementById(CURTAIN_ID);

    if (!decision.play || !host) {
      // The pre-paint hint may have hidden the page; put it back in the same frame.
      delete document.documentElement.dataset.intro;
      host?.remove();
      return;
    }

    // While the film runs, the page behind it is not reachable: a keyboard user must not
    // tab into a workspace they cannot see, and a screen reader must not read it out from
    // under the film. `inert` is the one attribute that does both, and it is removed with
    // the curtain.
    const behind = ["header", "main", "footer"]
      .map((tag) => document.querySelector(`body > ${tag}`))
      .filter((element): element is HTMLElement => element !== null);
    for (const element of behind) element.inert = true;

    // The marks are written when the film *starts*, not when it ends: a visitor who closes
    // the tab halfway through has still seen it, and replaying it on the next load is the
    // exact behaviour this exists to prevent.
    markSeen(
      {
        session: safeStore(() => window.sessionStorage),
        last: safeStore(() => window.localStorage),
      },
      Date.now(),
    );

    let cancelled = false;
    const release = () => {
      if (cancelled) return;
      cancelled = true;
      for (const element of behind) element.inert = false;
      delete document.documentElement.dataset.intro;
      host.remove();
    };

    import("./play")
      .then(({ play }) => play(host, { reduced: false }))
      .catch(() => {
        // A chunk that fails to load is not a reason to hold the page hostage.
      })
      .finally(release);

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
