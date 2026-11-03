"use client";

/**
 * The first-visit film, mounted once, on the landing page only.
 *
 * Four jobs, in this order:
 *
 * 1. **Decide.** `lib/intro-session.ts` owns the policy; this file only feeds it the marks,
 *    the date, the URL and the tab's visibility. The decision is made in an effect, never
 *    during render, because storage and `matchMedia` do not exist on the server and a
 *    render-time read is a hydration mismatch.
 * 2. **Load late.** The film is a dynamic import, so a visitor who is not going to see it
 *    downloads none of it: no GSAP, no WebGL, no bake. That is the whole reason the film
 *    can be 50 kB of animation without touching the page's first-load budget.
 * 3. **Give up quickly.** If the film's code and data are not ready 700 ms after first
 *    paint, the film is skipped silently and nothing is written, so the next session tries
 *    again. A slow network must not cost a visitor their one showing of the day.
 * 4. **Get out of the way.** Whatever happens — finished, skipped, reduced motion, a failed
 *    chunk — the page is restored and the curtain removed. A film that traps the visitor
 *    behind a sheet of paper is worse than no film.
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
  clearLegacy,
  clearSession,
  decideIntro,
  isDeepLink,
  localDay,
  markDay,
  markSession,
  readKnob,
  safeStore,
} from "@/lib/intro-session";

/** The element `layout.tsx` paints, so the film adopts it instead of adding another. */
export const CURTAIN_ID = "intro-curtain";

/** How long the film's code and bake have to arrive, measured from first paint. */
const READY_BUDGET_MS = 700;

/** First paint, as the browser measured it, or the navigation start when it did not. */
function firstPaintAt(): number {
  try {
    const paint = performance.getEntriesByType("paint")[0];
    if (paint && paint.startTime > 0) return paint.startTime;
  } catch {
    // Older browsers: fall through to the navigation start.
  }
  return 0;
}

export function IntroCurtain() {
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const session = safeStore(() => window.sessionStorage);
    const local = safeStore(() => window.localStorage);

    // The previous build stored a rolling timestamp. One line, once, and it is gone.
    clearLegacy(local);

    const today = localDay(new Date());
    const decision = decideIntro({
      session: session.get("unpackfund.intro.session"),
      day: local.get("unpackfund.intro.day"),
      today,
      reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      deepLink: isDeepLink(window.location.search, window.location.hash),
      hidden: document.hidden,
      knob: readKnob(window.location.search),
      storageReadable: local.readable(),
    });

    const host = document.getElementById(CURTAIN_ID);

    if (!decision.play || !host) {
      // The pre-paint hint may have covered the page; put it back in the same frame.
      delete document.documentElement.dataset.intro;
      host?.remove();
      return;
    }

    // Step 3 of the decision, before the film loads: two tabs opened at the same moment
    // cannot both play. Undone below if the film never starts.
    if (decision.writeSession) markSession(session);

    // While the film runs, the page behind it is not reachable: a keyboard user must not
    // tab into a workspace they cannot see, and a screen reader must not read it out from
    // under the film. `inert` is the one attribute that does both, and it is removed with
    // the curtain.
    const behind = ["header", "main", "footer"]
      .map((tag) => document.querySelector(`body > ${tag}`))
      .filter((element): element is HTMLElement => element !== null);
    for (const element of behind) element.inert = true;

    let cancelled = false;
    let began = false;

    const release = () => {
      if (cancelled) return;
      cancelled = true;
      for (const element of behind) element.inert = false;
      delete document.documentElement.dataset.intro;
      host.remove();
    };

    const onStart = () => {
      began = true;
      // Written when playback starts, not when it ends: a visitor who closes the tab
      // halfway through has still seen it.
      if (decision.writeSession) markDay(local, today);
    };

    const deadline = firstPaintAt() + READY_BUDGET_MS;
    const watchdog = window.setTimeout(
      () => {
        if (began) return;
        // Too slow: skip silently and leave no trace, so the next session tries again.
        if (decision.writeSession) clearSession(session);
        release();
      },
      Math.max(0, deadline - performance.now()),
    );

    import("./play")
      .then(({ play }) => {
        window.clearTimeout(watchdog);
        if (cancelled) return;
        return play(host, { forced: decision.reason === "forced", onStart });
      })
      .catch(() => {
        // A chunk that fails to load is not a reason to hold the page hostage.
      })
      .finally(() => {
        window.clearTimeout(watchdog);
        if (!began && decision.writeSession) clearSession(session);
        release();
      });

    return () => {
      cancelled = true;
      window.clearTimeout(watchdog);
    };
  }, []);

  // Pressing U on the landing replays the film. It reads and writes neither key, so a
  // visitor who wants to see it again can, and a visitor who does not is unaffected.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "u" && event.key !== "U") return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      if (document.getElementById(CURTAIN_ID)) return;

      const host = document.createElement("div");
      host.id = CURTAIN_ID;
      host.className = "intro-curtain";
      document.body.prepend(host);
      document.documentElement.dataset.intro = "play";

      const behind = ["header", "main", "footer"]
        .map((tag) => document.querySelector(`body > ${tag}`))
        .filter((element): element is HTMLElement => element !== null);
      for (const element of behind) element.inert = true;

      const release = () => {
        for (const element of behind) element.inert = false;
        delete document.documentElement.dataset.intro;
        host.remove();
      };

      import("./play")
        .then(({ play }) => play(host, { forced: true }))
        .catch(() => undefined)
        .finally(release);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return null;
}
