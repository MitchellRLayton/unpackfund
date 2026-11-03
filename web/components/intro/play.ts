/**
 * The seam between the film and the page.
 *
 * `play(host, { reduced })` is the whole contract. It fetches the baked field, builds the
 * stage inside the curtain the server painted, runs the 7.5 s film, and then *always* puts
 * everything back: the nodes it added, the inline styles it set on the page's own elements,
 * the GSAP globals it registered. It resolves `"done"` when the film reached its last frame
 * and `"skipped"` when the visitor (or their settings) cut it short, and it never rejects —
 * a film that throws is a film that traps the visitor behind a sheet of paper.
 *
 * The host is not this module's to remove: `IntroCurtain` paints it, adopts it, and drops it
 * once this promise settles. Everything here lives under one `.intro` div inside it, which is
 * what makes the teardown a single `remove()`.
 *
 * The page's furniture is hidden here rather than in CSS, and it is the only thing that hides
 * it: the handoff fades in the *real* header, title block and input at the same geometry the
 * film morphed to, so what the visitor sees resolve is the page itself and not a picture of
 * it. This file is therefore the sole owner of those elements' inline `opacity`, and every
 * value it sets is restored from a recorded prior value, not assumed to have been empty.
 */

import { gsap } from "gsap";

import "./intro.css";

import { buildScene, type Scene } from "./scene";
import { T, buildTimeline, type PageRefs, type TimelineHandle } from "./timeline";
import { parseField } from "./types";

export type PlayResult = "done" | "skipped";

export interface PlayOptions {
  reduced: boolean;
}

/** The only network request the film makes. */
const FIELD_URL = "/intro/field.json";

/**
 * The host is the sheet `layout.tsx` painted before any JavaScript ran, and it is opaque
 * paper so that the first frame of a first visit is never the workspace. The film's own
 * stage covers exactly the same rect with the same paper, so from the moment the paper
 * starts to lift, the host's sheet is a second opaque layer in front of the page — and the
 * page is the thing the handoff is revealing. Clearing it there (and only there: the set is
 * pinned to the paper fade, so every frame before it keeps the pre-paint sheet) is what lets
 * the real header, headline and input come through. The prior inline value is put back on
 * teardown like every other property this file touches.
 */
const CURTAIN_CLEAR_AT = T("pullback", 0.36);

/** How long the film waits for webfonts before it builds anyway. */
const FONT_TIMEOUT_MS = 1200;

/** An inline style this module set and must put back exactly as it found it. */
type Restore = {
  el: HTMLElement;
  opacity: string;
  pointerEvents: string | null;
  /** Whether the element had a `style` attribute before the film touched it. */
  hadStyle: boolean;
};

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export async function play(host: HTMLElement, opts: PlayOptions): Promise<PlayResult> {
  // Belt and braces: the session gate already refuses to start the film for a visitor who
  // asked for less motion, but a film that only respects that in one place is one refactor
  // away from not respecting it at all.
  if (opts.reduced || prefersReducedMotion()) return "skipped";

  const restores: Restore[] = [];
  const curtainBackground = host.style.backgroundColor;
  const curtainHadStyle = host.hasAttribute("style");
  let scene: Scene | null = null;
  let handle: TimelineHandle | null = null;
  let grain: gsap.core.Tween | null = null;
  let settled = false;
  let skipRequested = false;
  let outcome: PlayResult = "skipped";
  let resolveOutcome: (result: PlayResult) => void = () => {};
  const finished = new Promise<PlayResult>((resolve) => {
    resolveOutcome = resolve;
  });

  const input = document.querySelector<HTMLElement>("#add-holding");
  const page: PageRefs = {
    header: document.querySelector<HTMLElement>(".site-header"),
    eyebrow: document.querySelector<HTMLElement>(".eyebrow"),
    h1: document.querySelector<HTMLElement>("h1.title"),
    subtitle: document.querySelector<HTMLElement>("p.subtitle"),
    form: input,
    footer: document.querySelector<HTMLElement>(".site-footer"),
  };

  const hide = (el: HTMLElement | null, lockPointer: boolean): void => {
    if (el === null) return;
    restores.push({
      el,
      opacity: el.style.opacity,
      pointerEvents: lockPointer ? el.style.pointerEvents : null,
      hadStyle: el.hasAttribute("style"),
    });
    el.style.opacity = "0";
    if (lockPointer) el.style.pointerEvents = "none";
  };

  const finish = (result: PlayResult): void => {
    if (settled) return;
    settled = true;
    resolveOutcome(result);
  };

  const teardown = (): void => {
    window.removeEventListener("keydown", onKey, true);
    grain?.kill();
    grain = null;
    // Kill the timeline before touching inline styles, so GSAP cannot write over the restore.
    handle?.destroy();
    handle = null;
    scene?.root.remove();
    scene = null;
    // The sheet the layout painted goes back exactly as it was: the host outlives the film
    // (its owner removes it), and a transparent sheet left behind would flash the page on a
    // re-render or a second attempt.
    host.style.backgroundColor = curtainBackground;
    if (!curtainHadStyle && host.getAttribute("style") === "")
      host.removeAttribute("style");
    for (let index = restores.length - 1; index >= 0; index -= 1) {
      const item = restores[index]!;
      if (item.opacity === "") item.el.style.removeProperty("opacity");
      else item.el.style.opacity = item.opacity;
      if (item.pointerEvents !== null) {
        if (item.pointerEvents === "") item.el.style.removeProperty("pointer-events");
        else item.el.style.pointerEvents = item.pointerEvents;
      }
      // An element with no `style` attribute to begin with must go back to having none: an
      // empty `style=""` left behind is a visible diff in the markup and a lie about state.
      if (!item.hadStyle && item.el.getAttribute("style") === "")
        item.el.removeAttribute("style");
    }
    restores.length = 0;
  };

  function skip(): void {
    if (settled) return;
    skipRequested = true;
    if (handle !== null) {
      // Not a cut: the same timeline, run to its last frame in one frame, so the page arrives
      // already revealed instead of appearing out of a half-drawn field.
      handle.tl.pause();
      handle.tl.progress(1);
    }
    finish("skipped");
  }

  function onKey(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key !== "Escape" && event.key !== " " && event.key !== "Spacebar") return;
    event.preventDefault();
    skip();
  }

  // The page is hidden before anything is built, so no frame of it can appear under the film.
  hide(page.header, true);
  hide(page.eyebrow, false);
  hide(page.h1, false);
  hide(page.subtitle, false);
  hide(page.form, false);
  hide(page.footer, true);

  try {
    // Fonts first: SplitText must break the headline where the real font breaks it, and the
    // card's mono ticker must not reflow mid-animation. A slow font must not hold the film.
    if (document.fonts) {
      await Promise.race([
        document.fonts.ready,
        new Promise<void>((resolve) => window.setTimeout(resolve, FONT_TIMEOUT_MS)),
      ]);
    }
    if (!host.isConnected) {
      finish("skipped");
      outcome = "skipped";
      return outcome;
    }

    const response = await fetch(FIELD_URL);
    if (!response.ok) throw new Error(`field ${response.status}`);
    const field = parseField(await response.json());
    if (settled) {
      // Skipped while the field was in flight: nothing was built, nothing to undo.
      outcome = await finished;
      return outcome;
    }

    const built = buildScene(host, field, input);
    scene = built;

    handle = buildTimeline(built, page, {
      onFinish: () => {
        if (!skipRequested) finish("done");
      },
    });

    // The host's sheet and the film's paper are the same paper; from the frame the film
    // starts lifting its own, the host's must stop covering the page it is revealing.
    handle.tl.set(host, { backgroundColor: "transparent" }, CURTAIN_CLEAR_AT);

    // The grain drifts, so the paper is never quite still. It moves by exactly one tile and
    // repeats, which loops seamlessly and stays on the compositor.
    grain = gsap.to(built.grain, {
      x: 180,
      y: 180,
      duration: 7,
      repeat: -1,
      ease: "none",
    });

    built.skip.addEventListener("click", skip);
    window.addEventListener("keydown", onKey, true);
    handle.tl.play();

    outcome = await finished;
    return outcome;
  } catch {
    // A failed chunk, a malformed field, a browser that will not paint: the page comes back
    // and the visitor never knows a film was attempted.
    outcome = "skipped";
    return outcome;
  } finally {
    const focusable =
      outcome === "done" && (scene?.metrics.hasInput ?? false) ? input : null;
    teardown();
    // Only a film that reached its handoff gets to place the caret: a skip must not steal
    // focus from wherever the visitor already was.
    if (focusable !== null && focusable.isConnected) focusWhenReachable(focusable);
  }
}

/**
 * Focus the add field, the way the last line of the brief asks.
 *
 * `IntroCurtain` holds the page `inert` while the film runs and lifts it when this promise
 * settles, which means a focus call made from in here is dropped on the floor on the first
 * try. One zero-delay retry lands after the mount has released the page; the guard means a
 * visitor who has already clicked elsewhere is never dragged away from it.
 */
function focusWhenReachable(input: HTMLElement): void {
  const attempt = (): void => {
    if (!input.isConnected) return;
    input.focus({ preventScroll: true });
  };
  attempt();
  if (document.activeElement !== input) window.setTimeout(attempt, 0);
}
